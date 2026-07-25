import { AnalysisErrorCode, type AnalysisResult } from './analysis-types';

export enum FastSpectrumWorkerMessageType {
  Analyze = 'analyze',
  Result = 'result',
  Error = 'error',
}

export interface FastSpectrumAnalyzeRequest {
  type: FastSpectrumWorkerMessageType.Analyze;
  jobId: number;
  samples: Float32Array;
}

export interface FastSpectrumWorkerResponse {
  type: FastSpectrumWorkerMessageType;
  jobId: number;
  result?: AnalysisResult;
  code?: AnalysisErrorCode;
}

interface ActiveJob {
  id: number;
  resolve: (result: AnalysisResult) => void;
  reject: (reason: FastSpectrumClientError) => void;
}

export class FastSpectrumClientError extends Error {
  public constructor(public readonly code: AnalysisErrorCode) {
    super(code);
    this.name = 'FastSpectrumClientError';
  }
}

export class FastSpectrumClient {
  private worker: Worker | null = null;
  private activeJob: ActiveJob | null = null;
  private nextJobId = 1;
  private disposed = false;

  public analyze(samples: Float32Array): Promise<AnalysisResult> {
    if (this.disposed) {
      return Promise.reject(
        new FastSpectrumClientError(AnalysisErrorCode.WorkerFailed),
      );
    }
    this.cancel();

    const jobId = this.nextJobId;
    this.nextJobId += 1;
    const worker = this.createWorker();
    this.worker = worker;
    const workerSamples = samples.slice();

    return new Promise((resolve, reject) => {
      this.activeJob = { id: jobId, resolve, reject };
      const request: FastSpectrumAnalyzeRequest = {
        type: FastSpectrumWorkerMessageType.Analyze,
        jobId,
        samples: workerSamples,
      };
      worker.postMessage(request, [workerSamples.buffer]);
    });
  }

  public cancel(): void {
    if (this.activeJob !== null) {
      this.activeJob.reject(
        new FastSpectrumClientError(AnalysisErrorCode.Cancelled),
      );
      this.activeJob = null;
    }
    this.worker?.terminate();
    this.worker = null;
  }

  public dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private createWorker(): Worker {
    const worker = new Worker(
      new URL('./fast-spectrum-worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.addEventListener('message', event => this.handleMessage(worker, event));
    worker.addEventListener('error', () => this.handleFailure(worker));
    worker.addEventListener('messageerror', () => this.handleFailure(worker));
    return worker;
  }

  private readonly handleMessage = (
    worker: Worker,
    event: MessageEvent<FastSpectrumWorkerResponse>,
  ): void => {
    if (worker !== this.worker) {
      return;
    }
    const job = this.activeJob;
    const response = event.data;
    if (job === null || response.jobId !== job.id) {
      return;
    }
    this.activeJob = null;
    worker.terminate();
    this.worker = null;

    if (
      response.type === FastSpectrumWorkerMessageType.Result &&
      response.result !== undefined
    ) {
      job.resolve(response.result);
      return;
    }
    job.reject(
      new FastSpectrumClientError(
        response.code ?? AnalysisErrorCode.AnalysisFailed,
      ),
    );
  };

  private readonly handleFailure = (worker: Worker): void => {
    if (worker !== this.worker) {
      return;
    }
    const job = this.activeJob;
    worker.terminate();
    this.worker = null;
    this.activeJob = null;
    job?.reject(new FastSpectrumClientError(AnalysisErrorCode.WorkerFailed));
  };
}
