export enum AnalysisPhase {
  Idle = 'idle',
  Loading = 'loading',
  FastAnalyzing = 'fast-analyzing',
  PreviewReady = 'preview-ready',
  FastReady = 'fast-ready',
  Refining = 'refining',
  Complete = 'complete',
  Failed = 'failed',
}

export enum RecognitionMode {
  Instant = 'instant',
  Precise = 'precise',
}

export enum WorkerMessageType {
  Analyze = 'analyze',
  Progress = 'progress',
  Result = 'result',
  Error = 'error',
}

export enum AnalysisErrorCode {
  InvalidAudio = 'invalid-audio',
  BackendUnavailable = 'backend-unavailable',
  ModelLoadFailed = 'model-load-failed',
  AnalysisFailed = 'analysis-failed',
  Cancelled = 'cancelled',
  WorkerFailed = 'worker-failed',
}

export interface AppState {
  analysisPhase: AnalysisPhase;
  analysisProgress: number;
  analysisError: AnalysisErrorCode | null;
}

export interface AnalyzedNote {
  pitchMidi: number;
  amplitude: number;
  startFrame: number;
  endFrame: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
}

export interface AnalysisResult {
  notes: AnalyzedNote[];
  frameCount: number;
  pitchCount: number;
  frameProbabilities: Uint8Array;
  frameTimestamps: Float32Array;
}

export interface AnalyzeWorkerRequest {
  type: WorkerMessageType.Analyze;
  jobId: number;
  samples: Float32Array;
}

export interface AnalysisProgressWorkerMessage {
  type: WorkerMessageType.Progress;
  jobId: number;
  progress: number;
}

export interface AnalysisResultWorkerMessage {
  type: WorkerMessageType.Result;
  jobId: number;
  result: AnalysisResult;
}

export interface AnalysisErrorWorkerMessage {
  type: WorkerMessageType.Error;
  jobId: number;
  code: AnalysisErrorCode;
}

export type AnalysisWorkerRequest = AnalyzeWorkerRequest;

export type AnalysisWorkerResponse =
  | AnalysisProgressWorkerMessage
  | AnalysisResultWorkerMessage
  | AnalysisErrorWorkerMessage;

export interface AnalysisCallbacks {
  onProgress?: (progress: number) => void;
}
