# Spectral Score MVP

## Global Constraints

- Build a client-only Vite 8 + Vanilla TypeScript application with no backend and no runtime CDN calls.
- Use enums instead of string unions for application and worker states.
- UI language is Russian. Comments are allowed only when necessary and only in Russian.
- Do not run lint, tests, or typecheck unless the user asks separately.
- Target desktop Chromium.
- Accept browser-decodable audio up to 200 MB and 10 minutes.
- Analyze the complete file before playback with `@spotify/basic-pitch@1.0.1` and `@tensorflow/tfjs@3.21.0`.
- Keep Basic Pitch model files local under `public/models/basic-pitch/`.
- Perform inference in a module Web Worker, preferring TFJS WebGL with CPU fallback.
- Render all 88 piano pitches A0-C8 on Canvas.
- Use a 12-second rolling window with the fixed playhead at 36 percent of the spectrum width.
- Visual design: background `#F4F1EB`, surface `#FCFBF8`, text `#20242B`, grid `#D7D1C7`, note blue `#2447D8`, playhead red `#EE594D`.
- Notes use hybrid rendering: clear onset/offset outline plus frame-by-frame confidence brightness.
- Do not add backend, persistence, microphone input, MIDI export, pitch bend, zoom/pan, analysis settings, or mobile-specific UI.

## Task 1: Project scaffold and analysis pipeline

Create the Vite Vanilla TypeScript project and the complete analysis subsystem.

- Add package metadata and Vite/TypeScript configuration.
- Add local Basic Pitch model files and preserve required Apache-2.0 attribution.
- Define shared enums and interfaces for app state, worker messages, analysis errors, analyzed notes, and the compact analysis result.
- Implement a module Web Worker created with `new Worker(new URL(..., import.meta.url), { type: "module" })`.
- The worker initializes TFJS WebGL and falls back to CPU, loads `/models/basic-pitch/model.json`, accepts a transferable mono 22,050 Hz `Float32Array`, and reports progress.
- Analyze sequential 30-second PCM chunks with a 2-second overlap. Keep only the current chunk's Basic Pitch `frames` and `onsets`, ignore contours, call `outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)`, immediately quantize the chunk's central region into the final activation buffer, and merge overlap notes by pitch and time without duplicates.
- Preserve start/end frames, convert note timing with `noteFramesToTime`, quantize the 88-bin frame matrix into frame-major `Uint8Array`, and build a monotonic `Float32Array` of frame timestamps using the Basic Pitch timing formula.
- Return result buffers as transferables. Report user-safe error codes rather than raw exception strings.
- Implement `AnalysisClient` with job IDs, progress callbacks, stale-message rejection, worker termination, and worker recreation for cancellation.
- Do not implement the visible UI beyond the minimal boot entry needed for later tasks.

## Task 2: Audio player, Canvas renderer, and application integration

Build the entire upload -> decode -> analyze -> render -> playback flow on top of Task 1.

- Implement `AudioPlayer` around Web Audio API:
  - decode with `AudioContext.decodeAudioData`;
  - downmix/resample through mono `OfflineAudioContext` at 22,050 Hz;
  - create a fresh `AudioBufferSourceNode` for every play or seek;
  - track `offsetSeconds` and `startedAtContextTime`;
  - implement play, pause, seek, end handling, current time, and disposal.
- Reject files over 200 MB before decoding and decoded duration over 600 seconds.
- Implement the Russian UI states: empty drop zone, decoding, analysis progress, ready/player, and recoverable error.
- Use app name `SPECTRAL SCORE` and privacy text that processing stays on the device.
- Implement drag-and-drop plus file picker; replacing a file stops playback and cancels the previous analysis.
- Implement `PianoRollRenderer`:
  - high notes at top and low notes at bottom;
  - fixed 72 px piano keyboard;
  - all 88 rows, with C labels plus A0 and C8;
  - 12-second visible window and 36 percent playhead;
  - render only visible notes/frames;
  - per-frame blue alpha from the quantized activation and one outline per note;
  - highlight active piano keys at the current frame;
  - red fixed playhead and empty grid before/after the track;
  - device-pixel-ratio scaling and `ResizeObserver`.
- Add play/pause, current/duration label, HTML range timeline, smooth scrubbing, and seek by clicking the spectrum.
- Run `requestAnimationFrame` only while playing or scrubbing.
- At track end show the final frame, reset to paused, and make the next Play start at zero.

## Task 3: Product polish and edge-case hardening

Review and finish the integrated MVP without expanding scope.

- Match the approved light editorial design and keep controls minimal.
- Ensure keyboard, transport, focus states, drag state, progress state, and errors remain legible at typical desktop sizes.
- Add concise Russian messages for unsupported/corrupt audio, size/duration limits, model failure, backend failure, and analysis failure.
- Keep a working “Выбрать другой файл” recovery action in every error state.
- Prevent stale worker, source-node, RAF, resize, drag/drop, and object lifecycle callbacks from mutating a newer track.
- Add a short README with setup commands, Chromium target, privacy behavior, file limits, Basic Pitch accuracy limitation, and third-party attribution.
- Do not run lint, tests, typecheck, or build commands.
