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

export interface AnalyzedNote {
  pitchMidi: number;
  amplitude: number;
  startFrame: number;
  endFrame: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  instrument?: string;
}

export interface AnalysisResult {
  notes: AnalyzedNote[];
  frameCount: number;
  pitchCount: number;
  frameProbabilities: Uint8Array;
  frameTimestamps: Float32Array;
  midiBytes?: Uint8Array;
}

/**
 * Fast-spectrum runtime tuning knobs — every field optional; omitted values
 * reproduce the constant-driven behaviour the pipeline was tuned on.
 * sensitivity 0.5 is the neutral point (0 stricter, 1 more permissive);
 * minNoteMs is the minimum note duration; maxNotesPerFrame caps polyphony.
 */
export interface FastSpectrumOptions {
  sensitivity?: number;
  minNoteMs?: number;
  maxNotesPerFrame?: number;
}

export interface AnalysisWorkerRequest {
  type: WorkerMessageType.Analyze;
  jobId: number;
  samples: Float32Array;
  options?: FastSpectrumOptions;
}

export interface AnalysisProgressWorkerMessage {
  type: WorkerMessageType.Progress;
  jobId: number;
  progress: number;
  stage?: 'model' | 'prepare' | 'transcribe';
  notes?: AnalyzedNote[];
  /** Seconds of audio fully decoded by the precise engine so far. */
  refinedSeconds?: number;
  /** A complete interim result — the fast worker's 30-second preview. */
  preview?: AnalysisResult;
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
  detail?: string;
}

export type AnalysisWorkerResponse =
  | AnalysisProgressWorkerMessage
  | AnalysisResultWorkerMessage
  | AnalysisErrorWorkerMessage;

export interface AnalysisCallbacks {
  onProgress?: (
    progress: number,
    incrementalNotes?: AnalyzedNote[],
    stage?: 'model' | 'prepare' | 'transcribe',
    refinedSeconds?: number,
  ) => void;
  onPreview?: (result: AnalysisResult) => void;
}
