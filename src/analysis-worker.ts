import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';

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
const CHUNK_SECONDS = 30;
const CHUNK_OVERLAP_SECONDS = 2;
const CHUNK_EDGE_SECONDS = CHUNK_OVERLAP_SECONDS / 2;
const CHUNK_SAMPLES = CHUNK_SECONDS * AUDIO_SAMPLE_RATE;
const CHUNK_STEP_SAMPLES =
  (CHUNK_SECONDS - CHUNK_OVERLAP_SECONDS) * AUDIO_SAMPLE_RATE;

interface TimedNote {
  pitchMidi: number;
  amplitude: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
}

let basicPitchPromise: Promise<BasicPitch> | null = null;

function postMessageToClient(
  message: AnalysisWorkerResponse,
  transfer: Transferable[] = [],
): void {
  self.postMessage(message, transfer);
}

async function initializeBasicPitch(): Promise<BasicPitch> {
  try {
    await initializeCpuBackend();
    const model = await tf.loadGraphModel(MODEL_URL);
    return new BasicPitch(Promise.resolve(model));
  } catch {
    if (tf.getBackend() !== 'cpu') {
      throw new AnalysisWorkerError(AnalysisErrorCode.BackendUnavailable);
    }
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

function quantizeFrameRange(
  frames: number[][],
  startFrame: number,
  endFrame: number,
): Uint8Array {
  const quantized = new Uint8Array((endFrame - startFrame) * PITCH_COUNT);

  for (let frameIndex = startFrame; frameIndex < endFrame; frameIndex += 1) {
    const frame = frames[frameIndex];
    const outputOffset = (frameIndex - startFrame) * PITCH_COUNT;
    for (let pitchIndex = 0; pitchIndex < PITCH_COUNT; pitchIndex += 1) {
      const probability = frame[pitchIndex] ?? 0;
      quantized[outputOffset + pitchIndex] = Math.round(
        Math.min(1, Math.max(0, probability)) * 255,
      );
    }
  }

  return quantized;
}

function createChunkNotes(
  frames: number[][],
  onsets: number[][],
  chunkStartSeconds: number,
  durationSeconds: number,
): TimedNote[] {
  const notes = outputToNotesPoly(frames, onsets, 0.25, 0.25, 5);
  const timedNotes = noteFramesToTime(notes);

  return notes
    .map((note, index) => {
      const timedNote = timedNotes[index];
      const startTimeSeconds = Math.max(
        0,
        chunkStartSeconds + timedNote.startTimeSeconds,
      );
      const endTimeSeconds = Math.min(
        durationSeconds,
        startTimeSeconds + timedNote.durationSeconds,
      );
      return {
        pitchMidi: note.pitchMidi,
        amplitude: note.amplitude,
        startTimeSeconds,
        endTimeSeconds,
      };
    })
    .filter(note => note.endTimeSeconds > note.startTimeSeconds)
    .sort((left, right) => left.startTimeSeconds - right.startTimeSeconds);
}

function mergeChunkNotes(
  output: TimedNote[],
  latestNoteByPitch: Map<number, TimedNote>,
  chunkNotes: TimedNote[],
  keepStartSeconds: number,
  keepEndSeconds: number,
): void {
  const overlapNoteByPitch = new Map(latestNoteByPitch);

  for (const note of chunkNotes) {
    if (
      note.endTimeSeconds <= keepStartSeconds ||
      note.startTimeSeconds >= keepEndSeconds
    ) {
      continue;
    }

    const previous = overlapNoteByPitch.get(note.pitchMidi);
    const spansBoundary =
      previous !== undefined &&
      previous.startTimeSeconds <= keepStartSeconds &&
      previous.endTimeSeconds >= keepStartSeconds &&
      note.startTimeSeconds <= keepStartSeconds &&
      note.endTimeSeconds >= keepStartSeconds;
    const hasMatchingEdges =
      previous !== undefined &&
      Math.abs(previous.startTimeSeconds - note.startTimeSeconds) <= 0.08 &&
      Math.abs(previous.endTimeSeconds - note.endTimeSeconds) <= 0.08;

    if (previous !== undefined && (spansBoundary || hasMatchingEdges)) {
      previous.startTimeSeconds = Math.min(
        previous.startTimeSeconds,
        note.startTimeSeconds,
      );
      previous.endTimeSeconds = Math.max(
        previous.endTimeSeconds,
        note.endTimeSeconds,
      );
      previous.amplitude = Math.max(previous.amplitude, note.amplitude);
      latestNoteByPitch.set(note.pitchMidi, previous);
      overlapNoteByPitch.delete(note.pitchMidi);
      continue;
    }

    output.push(note);
    latestNoteByPitch.set(note.pitchMidi, note);
  }
}

function combineUint8Arrays(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function combineFrameTimestamps(
  chunks: Float32Array[],
  frameCount: number,
): Float32Array {
  const output = new Float32Array(frameCount);
  let offset = 0;
  let previousTimestamp = 0;

  for (const chunk of chunks) {
    for (const timestamp of chunk) {
      previousTimestamp = Math.max(timestamp, previousTimestamp);
      output[offset] = previousTimestamp;
      offset += 1;
    }
  }

  return output;
}

function lowerBound(values: Float32Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function finalizeNotes(
  notes: TimedNote[],
  frameTimestamps: Float32Array,
): AnalyzedNote[] {
  return notes
    .sort((left, right) => left.startTimeSeconds - right.startTimeSeconds)
    .map(note => {
      const startFrame = Math.min(
        Math.max(0, frameTimestamps.length - 1),
        lowerBound(frameTimestamps, note.startTimeSeconds),
      );
      const endFrame = Math.min(
        frameTimestamps.length,
        Math.max(
          startFrame + 1,
          lowerBound(frameTimestamps, note.endTimeSeconds),
        ),
      );
      return {
        ...note,
        startFrame,
        endFrame,
      };
    });
}

async function analyze(request: AnalysisWorkerRequest): Promise<AnalysisResult> {
  if (request.samples.length === 0) {
    throw new AnalysisWorkerError(AnalysisErrorCode.InvalidAudio);
  }

  const basicPitch = await getBasicPitch();
  const durationSeconds = request.samples.length / AUDIO_SAMPLE_RATE;
  const chunkCount =
    request.samples.length <= CHUNK_SAMPLES
      ? 1
      : 1 +
        Math.ceil(
          (request.samples.length - CHUNK_SAMPLES) / CHUNK_STEP_SAMPLES,
        );
  const probabilityChunks: Uint8Array[] = [];
  const timestampChunks: Float32Array[] = [];
  const notes: TimedNote[] = [];
  const latestNoteByPitch = new Map<number, TimedNote>();
  let frameCount = 0;
  let probabilityLength = 0;
  let lastProgress = 0;

  const reportProgress = (progress: number): void => {
    lastProgress = Math.max(lastProgress, Math.min(1, Math.max(0, progress)));
    postMessageToClient({
      type: WorkerMessageType.Progress,
      jobId: request.jobId,
      progress: lastProgress,
    });
  };

  reportProgress(0);

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const startSample = chunkIndex * CHUNK_STEP_SAMPLES;
    const endSample = Math.min(
      request.samples.length,
      startSample + CHUNK_SAMPLES,
    );
    const chunkStartSeconds = startSample / AUDIO_SAMPLE_RATE;
    const chunkEndSeconds = endSample / AUDIO_SAMPLE_RATE;
    const keepStartSeconds =
      chunkIndex === 0
        ? chunkStartSeconds
        : chunkStartSeconds + CHUNK_EDGE_SECONDS;
    const keepEndSeconds =
      chunkIndex === chunkCount - 1
        ? chunkEndSeconds
        : chunkEndSeconds - CHUNK_EDGE_SECONDS;
    const samples = request.samples.slice(startSample, endSample);
    let frames: number[][] = [];
    let onsets: number[][] = [];

    tf.engine().startScope(`analysis-chunk-${chunkIndex}`);
    try {
      await basicPitch.evaluateModel(
        samples,
        (frameChunk, onsetChunk) => {
          frames.push(...frameChunk);
          onsets.push(...onsetChunk);
        },
        chunkProgress => {
          reportProgress((chunkIndex + chunkProgress) / chunkCount);
        },
      );

      const firstFrame = lowerBoundChunkTime(
        frames.length,
        keepStartSeconds - chunkStartSeconds,
      );
      const lastFrame = lowerBoundChunkTime(
        frames.length,
        keepEndSeconds - chunkStartSeconds,
      );
      const selectedFrameCount = Math.max(0, lastFrame - firstFrame);
      const probabilities = quantizeFrameRange(
        frames,
        firstFrame,
        lastFrame,
      );
      const timestamps = new Float32Array(selectedFrameCount);
      for (
        let localFrame = firstFrame;
        localFrame < lastFrame;
        localFrame += 1
      ) {
        timestamps[localFrame - firstFrame] =
          chunkStartSeconds + modelFrameToTime(localFrame);
      }

      probabilityChunks.push(probabilities);
      timestampChunks.push(timestamps);
      frameCount += selectedFrameCount;
      probabilityLength += probabilities.length;

      mergeChunkNotes(
        notes,
        latestNoteByPitch,
        createChunkNotes(
          frames,
          onsets,
          chunkStartSeconds,
          durationSeconds,
        ),
        keepStartSeconds,
        keepEndSeconds,
      );
    } finally {
      frames = [];
      onsets = [];
      tf.engine().endScope();
    }
  }

  reportProgress(1);
  const frameTimestamps = combineFrameTimestamps(timestampChunks, frameCount);
  const frameProbabilities = combineUint8Arrays(
    probabilityChunks,
    probabilityLength,
  );

  return {
    notes: finalizeNotes(notes, frameTimestamps),
    frameCount,
    pitchCount: PITCH_COUNT,
    frameProbabilities,
    frameTimestamps,
  };
}

function lowerBoundChunkTime(frameCount: number, targetSeconds: number): number {
  let low = 0;
  let high = frameCount;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (modelFrameToTime(middle) < targetSeconds) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
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
