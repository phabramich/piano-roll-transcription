import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';
import '@tensorflow/tfjs-backend-webgl';

import {
  AnalysisErrorCode,
  type AnalysisResult,
  type AnalysisWorkerRequest,
  type AnalysisWorkerResponse,
  type AnalyzedNote,
  WorkerMessageType,
} from './analysis-types';

const MODEL_URL = '/models/basic-pitch/model.json';
const AUDIO_SAMPLE_RATE = 22050;
const FFT_HOP = 256;
const ANNOTATIONS_PER_SECOND = Math.floor(AUDIO_SAMPLE_RATE / FFT_HOP);
const ANNOTATION_WINDOW_FRAMES = ANNOTATIONS_PER_SECOND * 2;
const AUDIO_WINDOW_SAMPLES = AUDIO_SAMPLE_RATE * 2 - FFT_HOP;
const WINDOW_OFFSET =
  (FFT_HOP / AUDIO_SAMPLE_RATE) *
    (ANNOTATION_WINDOW_FRAMES - AUDIO_WINDOW_SAMPLES / FFT_HOP) +
  0.0018;
const PITCH_COUNT = 88;

let basicPitchPromise: Promise<BasicPitch> | null = null;

function postMessageToClient(
  message: AnalysisWorkerResponse,
  transfer: Transferable[] = [],
): void {
  self.postMessage(message, transfer);
}

async function initializeBasicPitch(): Promise<BasicPitch> {
  try {
    const usesWebGl = await tf.setBackend('webgl');
    if (usesWebGl) {
      await tf.ready();
    } else {
      await initializeCpuBackend();
    }
  } catch {
    await initializeCpuBackend();
  }

  try {
    const model = await tf.loadGraphModel(MODEL_URL);
    return new BasicPitch(Promise.resolve(model));
  } catch {
    throw new AnalysisWorkerError(AnalysisErrorCode.ModelLoadFailed);
  }
}

async function initializeCpuBackend(): Promise<void> {
  try {
    const usesCpu = await tf.setBackend('cpu');
    if (!usesCpu) {
      throw new Error('backend-unavailable');
    }
    await tf.ready();
  } catch {
    throw new AnalysisWorkerError(AnalysisErrorCode.BackendUnavailable);
  }
}

function getBasicPitch(): Promise<BasicPitch> {
  if (basicPitchPromise === null) {
    basicPitchPromise = initializeBasicPitch().catch(error => {
      basicPitchPromise = null;
      throw error;
    });
  }
  return basicPitchPromise;
}

function modelFrameToTime(frame: number): number {
  return (
    (frame * FFT_HOP) / AUDIO_SAMPLE_RATE -
    WINDOW_OFFSET * Math.floor(frame / ANNOTATION_WINDOW_FRAMES)
  );
}

function createFrameTimestamps(frameCount: number): Float32Array {
  const timestamps = new Float32Array(frameCount);
  let previousTimestamp = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const timestamp = modelFrameToTime(frame);
    previousTimestamp =
      frame === 0
        ? Math.max(timestamp, 0)
        : Math.max(timestamp, previousTimestamp);
    timestamps[frame] = previousTimestamp;
  }

  return timestamps;
}

function quantizeFrames(frames: number[][]): Uint8Array {
  const quantized = new Uint8Array(frames.length * PITCH_COUNT);

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    for (let pitchIndex = 0; pitchIndex < PITCH_COUNT; pitchIndex += 1) {
      const probability = frame[pitchIndex] ?? 0;
      quantized[frameIndex * PITCH_COUNT + pitchIndex] = Math.round(
        Math.min(1, Math.max(0, probability)) * 255,
      );
    }
  }

  return quantized;
}

function createAnalyzedNotes(frames: number[][], onsets: number[][]): AnalyzedNote[] {
  const notes = outputToNotesPoly(frames, onsets, 0.25, 0.25, 5);
  const timedNotes = noteFramesToTime(notes);

  return notes.map((note, index) => {
    const timedNote = timedNotes[index];
    return {
      pitchMidi: note.pitchMidi,
      amplitude: note.amplitude,
      startFrame: note.startFrame,
      endFrame: note.startFrame + note.durationFrames,
      startTimeSeconds: timedNote.startTimeSeconds,
      endTimeSeconds: timedNote.startTimeSeconds + timedNote.durationSeconds,
    };
  });
}

async function analyze(request: AnalysisWorkerRequest): Promise<AnalysisResult> {
  if (request.samples.length === 0) {
    throw new AnalysisWorkerError(AnalysisErrorCode.InvalidAudio);
  }

  const basicPitch = await getBasicPitch();
  const frames: number[][] = [];
  const onsets: number[][] = [];

  await basicPitch.evaluateModel(
    request.samples,
    (frameChunk, onsetChunk) => {
      frames.push(...frameChunk);
      onsets.push(...onsetChunk);
    },
    progress => {
      postMessageToClient({
        type: WorkerMessageType.Progress,
        jobId: request.jobId,
        progress: Math.min(1, Math.max(0, progress)),
      });
    },
  );

  const frameProbabilities = quantizeFrames(frames);
  const frameTimestamps = createFrameTimestamps(frames.length);

  return {
    notes: createAnalyzedNotes(frames, onsets),
    frameCount: frames.length,
    pitchCount: PITCH_COUNT,
    frameProbabilities,
    frameTimestamps,
  };
}

class AnalysisWorkerError extends Error {
  public constructor(public readonly code: AnalysisErrorCode) {
    super(code);
    this.name = 'AnalysisWorkerError';
  }
}

function toErrorCode(error: unknown): AnalysisErrorCode {
  if (error instanceof AnalysisWorkerError) {
    return error.code;
  }

  return AnalysisErrorCode.AnalysisFailed;
}

self.addEventListener('message', (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data;

  if (request.type !== WorkerMessageType.Analyze) {
    return;
  }

  void analyze(request)
    .then(result => {
      postMessageToClient(
        {
          type: WorkerMessageType.Result,
          jobId: request.jobId,
          result,
        },
        [result.frameProbabilities.buffer, result.frameTimestamps.buffer],
      );
    })
    .catch(error => {
      postMessageToClient({
        type: WorkerMessageType.Error,
        jobId: request.jobId,
        code: toErrorCode(error),
      });
    });
});
