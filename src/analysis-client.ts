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
  public constructor(
    public readonly code: AnalysisErrorCode,
    detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'AnalysisClientError';
  }
}

export class AnalysisClient {
  private worker: Worker | null = null;
  private activeJob: ActiveJob | null = null;
  private nextJobId = 1;
  private disposed = false;

  public constructor(
    private readonly createWorkerInstance: () => Worker = () =>
      new Worker(new URL('./analysis-worker.ts', import.meta.url), {
        type: 'module',
      }),
  ) {}

  public analyze(
    samples: Float32Array,
    callbacks: AnalysisCallbacks = {},
  ): Promise<AnalysisResult> {
    if (this.disposed) {
      return Promise.reject(
        new AnalysisClientError(AnalysisErrorCode.WorkerFailed),
      );
    }
    if (this.activeJob !== null) {
      this.cancel();
    }

    const jobId = this.nextJobId;
    this.nextJobId += 1;
    const worker = this.worker ?? this.createWorker();
    this.worker = worker;

    return new Promise((resolve, reject) => {
      this.activeJob = { id: jobId, callbacks, resolve, reject };
      const request: AnalyzeWorkerRequest = {
        type: WorkerMessageType.Analyze,
        jobId,
        samples,
      };
      worker.postMessage(request, [samples.buffer]);
    });
  }

  public cancel(): void {
    if (this.activeJob !== null) {
      this.activeJob.reject(new AnalysisClientError(AnalysisErrorCode.Cancelled));
      this.activeJob = null;
    }

    this.worker?.terminate();
    this.worker = null;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.activeJob !== null) {
      this.activeJob.reject(new AnalysisClientError(AnalysisErrorCode.Cancelled));
      this.activeJob = null;
    }

    this.worker?.terminate();
    this.worker = null;
  }

  private createWorker(): Worker {
    const worker = this.createWorkerInstance();
    worker.addEventListener('message', event => this.handleWorkerMessage(worker, event));
    worker.addEventListener('error', () => this.handleWorkerFailure(worker));
    worker.addEventListener('messageerror', () => this.handleWorkerFailure(worker));
    return worker;
  }

  private readonly handleWorkerMessage = (
    worker: Worker,
    event: MessageEvent<AnalysisWorkerResponse>,
  ): void => {
    if (worker !== this.worker) {
      return;
    }
    const job = this.activeJob;
    const message = event.data;

    if (job === null || message.jobId !== job.id) {
      return;
    }

    if (message.type === WorkerMessageType.Progress) {
      job.callbacks.onProgress?.(message.progress, message.notes, message.stage, message.refinedSeconds);
      return;
    }

    this.activeJob = null;

    if (message.type === WorkerMessageType.Result) {
      job.resolve(message.result);
      return;
    }

    job.reject(new AnalysisClientError(message.code, message.detail));
  };

  private readonly handleWorkerFailure = (worker: Worker): void => {
    if (worker !== this.worker) {
      return;
    }

    const job = this.activeJob;
    worker.terminate();
    this.worker = null;

    if (job !== null) {
      this.activeJob = null;
      job.reject(new AnalysisClientError(AnalysisErrorCode.WorkerFailed));
    }
  };
}
