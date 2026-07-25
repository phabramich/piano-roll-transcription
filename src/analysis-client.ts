import {
  AnalysisErrorCode,
  type AnalysisCallbacks,
  type AnalysisResult,
  type AnalysisWorkerResponse,
  type AnalyzeWorkerRequest,
  WorkerMessageType,
} from './analysis-types';

interface ActiveJob {
  id: number;
  callbacks: AnalysisCallbacks;
  resolve: (result: AnalysisResult) => void;
  reject: (reason: AnalysisClientError) => void;
}

export class AnalysisClientError extends Error {
  public constructor(public readonly code: AnalysisErrorCode) {
    super(code);
    this.name = 'AnalysisClientError';
  }
}

export class AnalysisClient {
  private worker: Worker;
  private activeJob: ActiveJob | null = null;
  private nextJobId = 1;

  public constructor() {
    this.worker = this.createWorker();
  }

  public analyze(
    samples: Float32Array,
    callbacks: AnalysisCallbacks = {},
  ): Promise<AnalysisResult> {
    if (this.activeJob !== null) {
      this.cancel();
    }

    const jobId = this.nextJobId;
    this.nextJobId += 1;

    return new Promise((resolve, reject) => {
      this.activeJob = { id: jobId, callbacks, resolve, reject };
      const request: AnalyzeWorkerRequest = {
        type: WorkerMessageType.Analyze,
        jobId,
        samples,
      };
      this.worker.postMessage(request, [samples.buffer]);
    });
  }

  public cancel(): void {
    if (this.activeJob !== null) {
      this.activeJob.reject(new AnalysisClientError(AnalysisErrorCode.Cancelled));
      this.activeJob = null;
    }

    this.worker.terminate();
    this.worker = this.createWorker();
  }

  public dispose(): void {
    if (this.activeJob !== null) {
      this.activeJob.reject(new AnalysisClientError(AnalysisErrorCode.Cancelled));
      this.activeJob = null;
    }

    this.worker.terminate();
  }

  private createWorker(): Worker {
    const worker = new Worker(
      new URL('./analysis-worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.addEventListener('message', this.handleWorkerMessage);
    worker.addEventListener('error', this.handleWorkerFailure);
    worker.addEventListener('messageerror', this.handleWorkerFailure);
    return worker;
  }

  private readonly handleWorkerMessage = (
    event: MessageEvent<AnalysisWorkerResponse>,
  ): void => {
    const job = this.activeJob;
    const message = event.data;

    if (job === null || message.jobId !== job.id) {
      return;
    }

    if (message.type === WorkerMessageType.Progress) {
      job.callbacks.onProgress?.(message.progress);
      return;
    }

    this.activeJob = null;

    if (message.type === WorkerMessageType.Result) {
      job.resolve(message.result);
      return;
    }

    job.reject(new AnalysisClientError(message.code));
  };

  private readonly handleWorkerFailure = (): void => {
    const job = this.activeJob;

    if (job === null) {
      return;
    }

    this.activeJob = null;
    job.reject(new AnalysisClientError(AnalysisErrorCode.WorkerFailed));
  };
}
