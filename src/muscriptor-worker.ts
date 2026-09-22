import {
  AnalysisErrorCode,
  type AnalysisResult,
  type AnalysisWorkerRequest,
  type AnalysisWorkerResponse,
  type AnalyzedNote,
  WorkerMessageType,
} from './analysis-types';

/*
 * MuScriptor (audio.cpp) worker.
 *
 * Loads the Emscripten build of audio.cpp's muscriptor pipeline once, then
 * streams decoded PCM through it in ~5 s chunks. Each pushed chunk can emit
 * note-on/note-off events, which are reported as incremental progress so the
 * piano roll fills in while the model works.
 *
 * Requires cross-origin isolation (SharedArrayBuffer for pthreads) and ~3 GB
 * of wasm memory for the GGUF plus decoder arenas.
 */

const MODULE_JS_URL = '/models/muscriptor/muscriptor.js';
const MODEL_GGUF_URL = '/models/muscriptor/muscriptor-small-q8_0.gguf';
const MODEL_CACHE_NAME = 'muscriptor-gguf-v2';
const MODEL_PATH_IN_FS = '/muscriptor-small-q8_0.gguf';
const MODEL_SAMPLE_RATE = 22050;
const CHUNK_SECONDS = 5;
const FRAMES_PER_SECOND = MODEL_SAMPLE_RATE / 256;
const PITCH_COUNT = 88;
const FIRST_MIDI_NOTE = 21;
const DEFAULT_AMPLITUDE = 0.85;

interface MuscriptorEventStart {
  type: 'start';
  pitch: number;
  start_time: number;
  index: number;
  instrument?: string;
}

interface MuscriptorEventEnd {
  type: 'end';
  end_time: number;
  start_event_index: number;
}

type MuscriptorEvent = MuscriptorEventStart | MuscriptorEventEnd;

interface MuscriptorModule {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  };
  loadModel(path: string, threads: number): boolean;
  streamBegin(sampleRate: number, channels: number): unknown;
  streamPush(
    pcm: Float32Array,
    sampleRate: number,
    startSeconds: number,
  ): unknown;
  streamFinish(): {
    eventsJson?: string;
    midi?: Uint8Array;
    error?: string;
  };
  streamAbort?(): void;
  lastError(): string;
  unload(): void;
}

interface TimedNote {
  pitchMidi: number;
  amplitude: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  instrument?: string;
}

class MuscriptorWorkerError extends Error {
  public constructor(public readonly code: AnalysisErrorCode) {
    super(code);
    this.name = 'MuscriptorWorkerError';
  }
}

let modulePromise: Promise<MuscriptorModule> | null = null;
let modelReady = false;

function postMessageToClient(
  message: AnalysisWorkerResponse,
  transfer: Transferable[] = [],
): void {
  self.postMessage(message, transfer);
}

function isValError(value: unknown): value is Error {
  return value instanceof Error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function fetchModelBytes(jobId: number): Promise<Uint8Array> {
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const cached = await cache.match(MODEL_GGUF_URL);
    if (cached !== undefined) {
      return new Uint8Array(await cached.arrayBuffer());
    }
  } catch {
    // Cache API unavailable (private mode etc.) — fall through to network.
  }

  const response = await fetch(MODEL_GGUF_URL);
  if (!response.ok || response.body === null) {
    throw new MuscriptorWorkerError(AnalysisErrorCode.ModelLoadFailed);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReported = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.byteLength;
    if (total > 0) {
      const progress = loaded / total;
      if (progress - lastReported >= 0.02 || progress >= 1) {
        lastReported = progress;
        postMessageToClient({
          type: WorkerMessageType.Progress,
          jobId,
          progress,
          stage: 'model',
        });
      }
    }
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    await cache.put(
      MODEL_GGUF_URL,
      new Response(bytes.slice().buffer, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
  } catch {
    // Best-effort caching only.
  }

  return bytes;
}

async function createModuleInstance(): Promise<MuscriptorModule> {
  const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory;
  if (
    typeof SharedArrayBuffer === 'undefined' ||
    !globalThis.crossOriginIsolated ||
    // A 2 GB wasm heap is a desktop-class workload — a failed allocation on a
    // phone often kills the tab instead of throwing, so gate it out here.
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ||
    // iPadOS reports a desktop "Macintosh" UA — detect it via touch points.
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ||
    (deviceMemory !== undefined && deviceMemory < 8)
  ) {
    throw new MuscriptorWorkerError(AnalysisErrorCode.BackendUnavailable);
  }

  const moduleUrl = new URL(MODULE_JS_URL, self.location.origin).href;
  const { default: createModule } = (await import(
    /* @vite-ignore */ moduleUrl
  )) as { default: () => Promise<MuscriptorModule> };
  return createModule();
}

async function loadModelInto(
  module: MuscriptorModule,
  jobId: number,
): Promise<void> {
  const modelBytes = await fetchModelBytes(jobId);

  postMessageToClient({
    type: WorkerMessageType.Progress,
    jobId,
    progress: 0,
    stage: 'prepare',
  });

  // Drop the pre-quantization cache entry (~400 MB) once, best-effort.
  void caches.delete('muscriptor-gguf-v1').catch(() => undefined);

  module.FS.writeFile(MODEL_PATH_IN_FS, modelBytes);
  const threads = Math.max(
    2,
    Math.min(16, navigator.hardwareConcurrency || 4),
  );
  try {
    if (!module.loadModel(MODEL_PATH_IN_FS, threads)) {
      throw new MuscriptorWorkerError(AnalysisErrorCode.ModelLoadFailed);
    }
  } finally {
    // Free the ~110 MB MEMFS copy whether loadModel succeeded or not — the
    // tensors are already in the heap on success, and on failure the file is
    // rewritten on the next attempt anyway.
    module.FS.unlink(MODEL_PATH_IN_FS);
  }
}

async function getModule(jobId: number): Promise<MuscriptorModule> {
  if (modulePromise === null) {
    modulePromise = createModuleInstance().catch(error => {
      modulePromise = null;
      throw error;
    });
  }
  // Model loading is separate from module creation: a failed loadModel retry
  // reuses the same module instead of orphaning a 2 GB heap + pthread pool.
  const module = await modulePromise;
  if (!modelReady) {
    await loadModelInto(module, jobId);
    modelReady = true;
  }
  return module;
}

function parseEvents(json: string): MuscriptorEvent[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as MuscriptorEvent[]) : [];
}

function pairEvents(
  events: MuscriptorEvent[],
  openNotes: Map<number, TimedNote & { pitchMidi: number }>,
  output: TimedNote[],
): void {
  for (const event of events) {
    if (event.type === 'start') {
      if (event.instrument !== 'drums') {
        openNotes.set(event.index, {
          pitchMidi: event.pitch,
          amplitude: DEFAULT_AMPLITUDE,
          startTimeSeconds: event.start_time,
          endTimeSeconds: event.start_time,
          instrument: event.instrument,
        });
      }
      continue;
    }
    const open = openNotes.get(event.start_event_index);
    if (open === undefined) {
      continue;
    }
    openNotes.delete(event.start_event_index);
    if (event.end_time > open.startTimeSeconds) {
      output.push({
        pitchMidi: open.pitchMidi,
        amplitude: open.amplitude,
        startTimeSeconds: open.startTimeSeconds,
        endTimeSeconds: event.end_time,
        instrument: open.instrument,
      });
    }
  }
}

function parseEventStrings(rawEvents: unknown): MuscriptorEvent[] {
  if (!Array.isArray(rawEvents)) {
    return [];
  }
  const events: MuscriptorEvent[] = [];
  for (const raw of rawEvents) {
    if (typeof raw !== 'string') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        ((parsed as MuscriptorEvent).type === 'start' ||
          (parsed as MuscriptorEvent).type === 'end')
      ) {
        events.push(parsed as MuscriptorEvent);
      }
    } catch {
      // Skip malformed event payloads.
    }
  }
  return events;
}

// The engine emits {"type":"progress","completed":N,"total":M} artifacts after
// each decoded segment — completed segments cover completed * CHUNK_SECONDS.
function parseProgressSeconds(rawEvents: unknown): number | undefined {
  if (!Array.isArray(rawEvents)) {
    return undefined;
  }
  let completed = 0;
  for (const raw of rawEvents) {
    if (typeof raw !== 'string') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'progress'
      ) {
        const done = (parsed as { completed?: unknown }).completed;
        if (typeof done === 'number' && done > completed) {
          completed = done;
        }
      }
    } catch {
      // Skip malformed payloads.
    }
  }
  return completed > 0 ? completed * CHUNK_SECONDS : undefined;
}

const MIDI_PPQ = 480;
const MIDI_TEMPO_US_PER_QN = 500000;
const MIDI_TICKS_PER_SECOND = MIDI_PPQ * 2;
const MIDI_VELOCITY = 96;

const GM_PROGRAMS: Record<string, number> = {
  acoustic_piano: 0, electric_piano: 2, chromatic_percussion: 8, organ: 16,
  acoustic_guitar: 24, clean_electric_guitar: 26, distorted_electric_guitar: 29,
  acoustic_bass: 32, electric_bass: 33, violin: 40, viola: 41, cello: 42,
  contrabass: 43, orchestral_harp: 46, timpani: 47, string_ensemble: 48,
  synth_strings: 50, voice: 52, orchestra_hit: 55, trumpet: 56,
  trombone: 57, tuba: 58, french_horn: 60, brass_section: 61,
  soprano_and_alto_sax: 64, tenor_sax: 66, baritone_sax: 67, oboe: 68,
  english_horn: 69, bassoon: 70, clarinet: 71, flutes: 72,
  synth_lead: 80, synth_pad: 88,
};

function gmProgram(instrument: string | undefined): number {
  if (instrument === undefined) {
    return 0;
  }
  const known = GM_PROGRAMS[instrument];
  if (known !== undefined) {
    return known;
  }
  if (instrument.startsWith('program_')) {
    const program = Number(instrument.slice(8));
    if (Number.isInteger(program) && program >= 0 && program <= 127) {
      return program;
    }
  }
  return 0;
}

function trackName(instrument: string | undefined): string {
  if (instrument === undefined) {
    return 'Notes';
  }
  const name = instrument.replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function midiVarint(value: number): number[] {
  let remaining = Math.max(0, Math.floor(value));
  const bytes = [remaining & 0x7f];
  remaining >>>= 7;
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  return bytes;
}

interface MidiTrackEvent {
  tick: number;
  order: number;
  data: number[];
}

function buildMidiTrack(events: MidiTrackEvent[]): number[] {
  events.sort((left, right) => left.tick - right.tick || left.order - right.order);
  const bytes: number[] = [];
  let lastTick = 0;
  for (const event of events) {
    bytes.push(...midiVarint(event.tick - lastTick), ...event.data);
    lastTick = event.tick;
  }
  bytes.push(0, 0xff, 0x2f, 0x00);
  return bytes;
}

function encodeMidi(notes: TimedNote[]): Uint8Array {
  const groups = new Map<string, TimedNote[]>();
  for (const note of notes) {
    const key = note.instrument ?? '';
    const group = groups.get(key);
    if (group !== undefined) {
      group.push(note);
    } else {
      groups.set(key, [note]);
    }
  }

  const tracks: number[][] = [
    buildMidiTrack([
      {
        tick: 0,
        order: 0,
        data: [
          0xff, 0x51, 0x03,
          (MIDI_TEMPO_US_PER_QN >> 16) & 0xff,
          (MIDI_TEMPO_US_PER_QN >> 8) & 0xff,
          MIDI_TEMPO_US_PER_QN & 0xff,
        ],
      },
    ]),
  ];

  let trackIndex = 0;
  for (const [instrument, group] of groups) {
    const channel = Math.min(trackIndex + (trackIndex >= 9 ? 1 : 0), 15);
    const name = [...trackName(instrument === '' ? undefined : instrument)];
    const events: MidiTrackEvent[] = [
      {
        tick: 0,
        order: 0,
        data: [0xff, 0x03, name.length, ...name.map(char => char.charCodeAt(0) & 0x7f)],
      },
      {
        tick: 0,
        order: 1,
        data: [0xc0 | channel, gmProgram(instrument === '' ? undefined : instrument)],
      },
    ];
    for (const note of group) {
      const pitch = Math.min(127, Math.max(0, Math.round(note.pitchMidi)));
      const onTick = Math.round(note.startTimeSeconds * MIDI_TICKS_PER_SECOND);
      const offTick = Math.max(
        onTick + 1,
        Math.round(note.endTimeSeconds * MIDI_TICKS_PER_SECOND),
      );
      events.push(
        { tick: offTick, order: 2, data: [0x80 | channel, pitch, 0] },
        { tick: onTick, order: 3, data: [0x90 | channel, pitch, MIDI_VELOCITY] },
      );
    }
    tracks.push(buildMidiTrack(events));
    trackIndex += 1;
  }

  const body: number[] = [];
  for (const track of tracks) {
    body.push(0x4d, 0x54, 0x72, 0x6b);
    body.push(
      (track.length >>> 24) & 0xff,
      (track.length >>> 16) & 0xff,
      (track.length >>> 8) & 0xff,
      track.length & 0xff,
    );
    body.push(...track);
  }
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    0, 1, (tracks.length >>> 8) & 0xff, tracks.length & 0xff,
    (MIDI_PPQ >>> 8) & 0xff, MIDI_PPQ & 0xff,
  ];
  return new Uint8Array([...header, ...body]);
}

function buildResult(
  notes: TimedNote[],
  durationSeconds: number,
  midi?: Uint8Array,
): AnalysisResult {
  const frameCount = Math.max(1, Math.ceil(durationSeconds * FRAMES_PER_SECOND));
  const frameTimestamps = new Float32Array(frameCount);
  const frameProbabilities = new Uint8Array(frameCount * PITCH_COUNT);

  for (let frame = 0; frame < frameCount; frame += 1) {
    frameTimestamps[frame] = frame / FRAMES_PER_SECOND;
  }

  const finalized: AnalyzedNote[] = notes
    .filter(
      note =>
        note.pitchMidi >= FIRST_MIDI_NOTE &&
        note.pitchMidi < FIRST_MIDI_NOTE + PITCH_COUNT,
    )
    .sort((left, right) => left.startTimeSeconds - right.startTimeSeconds)
    .map(note => {
      const startFrame = Math.min(
        frameCount - 1,
        Math.max(0, Math.floor(note.startTimeSeconds * FRAMES_PER_SECOND)),
      );
      const endFrame = Math.min(
        frameCount,
        Math.max(
          startFrame + 1,
          Math.ceil(note.endTimeSeconds * FRAMES_PER_SECOND),
        ),
      );
      const row = note.pitchMidi - FIRST_MIDI_NOTE;
      const cell = Math.round(note.amplitude * 255);
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        frameProbabilities[frame * PITCH_COUNT + row] = cell;
      }
      return {
        pitchMidi: note.pitchMidi,
        amplitude: note.amplitude,
        startFrame,
        endFrame,
        startTimeSeconds: note.startTimeSeconds,
        endTimeSeconds: note.endTimeSeconds,
        instrument: note.instrument,
      };
    });

  const result: AnalysisResult = {
    notes: finalized,
    frameCount,
    pitchCount: PITCH_COUNT,
    frameProbabilities,
    frameTimestamps,
  };
  if (midi !== undefined) {
    result.midiBytes = midi;
  }
  return result;
}

async function analyze(request: {
  jobId: number;
  samples: Float32Array;
}): Promise<AnalysisResult> {
  if (request.samples.length === 0) {
    throw new MuscriptorWorkerError(AnalysisErrorCode.InvalidAudio);
  }

  const module = await getModule(request.jobId);

  try {
    const beginError = module.streamBegin(MODEL_SAMPLE_RATE, 1);
    if (isValError(beginError)) {
      throw beginError;
    }

    const durationSeconds = request.samples.length / MODEL_SAMPLE_RATE;
    const chunkFrames = CHUNK_SECONDS * MODEL_SAMPLE_RATE;
    const chunkCount = Math.ceil(request.samples.length / chunkFrames);
    const openNotes = new Map<number, TimedNote & { pitchMidi: number }>();
    const notes: TimedNote[] = [];
    let streamedEventCount = 0;
    let lastProgress = 0;

    const reportTranscribe = (
      progress: number,
      incremental: TimedNote[],
      refinedSeconds?: number,
    ) => {
      lastProgress = Math.max(lastProgress, Math.min(1, Math.max(0, progress)));
      postMessageToClient({
        type: WorkerMessageType.Progress,
        jobId: request.jobId,
        progress: lastProgress,
        stage: 'transcribe',
        refinedSeconds,
        notes: incremental.map(note => ({
          pitchMidi: note.pitchMidi,
          amplitude: note.amplitude,
          startFrame: 0,
          endFrame: 0,
          startTimeSeconds: note.startTimeSeconds,
          endTimeSeconds: note.endTimeSeconds,
          instrument: note.instrument,
        })),
      });
    };

    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const start = chunk * chunkFrames;
      const end = Math.min(request.samples.length, start + chunkFrames);
      const pushed = module.streamPush(
        request.samples.subarray(start, end),
        MODEL_SAMPLE_RATE,
        start / MODEL_SAMPLE_RATE,
      );
      if (isValError(pushed)) {
        throw pushed;
      }
      const before = notes.length;
      const events = parseEventStrings(pushed);
      streamedEventCount += events.length;
      pairEvents(events, openNotes, notes);
      // Each push decodes the newly completed 5 s segment, so pushed fraction
      // is real progress; the tail segment + result encode run in streamFinish.
      reportTranscribe(
        0.95 * ((chunk + 1) / chunkCount),
        notes.slice(before),
        parseProgressSeconds(pushed),
      );
    }

    const finished = module.streamFinish();
    if (typeof finished.error === 'string' && finished.error.length > 0) {
      throw new Error(finished.error);
    }
    if (typeof finished.eventsJson === 'string') {
      // eventsJson repeats every event from the start — skip the prefix that
      // already streamed through streamPush.
      pairEvents(parseEvents(finished.eventsJson).slice(streamedEventCount), openNotes, notes);
    }
    for (const open of openNotes.values()) {
      if (open.endTimeSeconds > open.startTimeSeconds) {
        notes.push({
          pitchMidi: open.pitchMidi,
          amplitude: open.amplitude,
          startTimeSeconds: open.startTimeSeconds,
          endTimeSeconds: open.endTimeSeconds,
          instrument: open.instrument,
        });
      }
    }

    return buildResult(notes, durationSeconds, encodeMidi(notes));
  } catch (error) {
    // Drop the in-flight stream and its buffered audio so the next run starts
    // on a clean session. May itself throw if the wasm instance aborted.
    try {
      module.streamAbort?.();
    } catch {
      // Module is dead — the client will recycle the worker.
    }
    throw error;
  }
}

function toErrorCode(error: unknown): AnalysisErrorCode {
  if (error instanceof MuscriptorWorkerError) {
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
      const transfer: Transferable[] = [
        result.frameProbabilities.buffer,
        result.frameTimestamps.buffer,
      ];
      if (result.midiBytes !== undefined) {
        transfer.push(result.midiBytes.buffer);
      }
      postMessageToClient(
        {
          type: WorkerMessageType.Result,
          jobId: request.jobId,
          result,
        },
        transfer,
      );
    })
    .catch(error => {
      postMessageToClient({
        type: WorkerMessageType.Error,
        jobId: request.jobId,
        code: toErrorCode(error),
        detail: toError(error).message.slice(0, 300),
      });
    });
});
