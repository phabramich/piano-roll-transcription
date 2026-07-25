import type { AnalyzedNote, AnalysisResult } from './analysis-types';

const FIRST_MIDI_NOTE = 21;
const LAST_MIDI_NOTE = 108;
const PIANO_KEYBOARD_WIDTH = 72;
const VISIBLE_SECONDS = 12;
const PLAYHEAD_POSITION = 0.36;
const NOTES_PER_INDEX_BLOCK = 64;

interface NoteIndexBlock {
  notes: AnalyzedNote[];
  maximumEndTimeSeconds: number;
}

export class PianoRollRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private result: AnalysisResult | null = null;
  private noteIndex: NoteIndexBlock[] = [];
  private durationSeconds = 0;
  private currentTimeSeconds = 0;
  private disposed = false;

  public onSeek: ((seconds: number) => void) | null = null;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Canvas 2D is not available');
    }

    this.context = context;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('click', this.handleClick);
    this.resize();
  }

  public setAnalysis(result: AnalysisResult, durationSeconds: number): void {
    if (this.disposed) {
      return;
    }
    this.result = result;
    this.noteIndex = createNoteIndex(result.notes);
    this.durationSeconds = durationSeconds;
    this.render(this.currentTimeSeconds);
  }

  public clear(): void {
    if (this.disposed) {
      return;
    }
    this.result = null;
    this.noteIndex = [];
    this.durationSeconds = 0;
    this.currentTimeSeconds = 0;
    this.render(0);
  }

  public render(currentTimeSeconds: number): void {
    if (this.disposed) {
      return;
    }
    this.currentTimeSeconds = currentTimeSeconds;
    const { width, height } = this.canvas;
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = width / ratio;
    const cssHeight = height / ratio;
    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    const gridLeft = PIANO_KEYBOARD_WIDTH;
    const gridWidth = Math.max(0, cssWidth - gridLeft);
    const rowHeight = cssHeight / 88;
    const windowStart = currentTimeSeconds - VISIBLE_SECONDS * PLAYHEAD_POSITION;
    const windowEnd = windowStart + VISIBLE_SECONDS;

    this.drawKeyboard(rowHeight, cssHeight);
    this.drawGrid(gridLeft, gridWidth, rowHeight, cssHeight, windowStart);

    if (this.result !== null && gridWidth > 0) {
      context.save();
      context.beginPath();
      context.rect(gridLeft, 0, gridWidth, cssHeight);
      context.clip();
      this.drawFrames(gridLeft, gridWidth, rowHeight, windowStart, windowEnd);
      this.drawNoteOutlines(gridLeft, gridWidth, rowHeight, windowStart, windowEnd);
      context.restore();
      this.drawActiveKeys(rowHeight);
    }

    const playheadX = gridLeft + gridWidth * PLAYHEAD_POSITION;
    context.fillStyle = '#ff4e5d';
    context.fillRect(playheadX - 1, 0, 2, cssHeight);
  }

  public dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('click', this.handleClick);
  }

  private resize(): void {
    if (this.disposed) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    this.render(this.currentTimeSeconds);
  }

  private drawKeyboard(rowHeight: number, height: number): void {
    const context = this.context;
    for (let row = 0; row < 88; row += 1) {
      const midi = LAST_MIDI_NOTE - row;
      const y = row * rowHeight;
      context.fillStyle = isBlackKey(midi) ? '#3b362e' : '#fffdf7';
      context.fillRect(0, y, PIANO_KEYBOARD_WIDTH, rowHeight + 0.5);
      context.strokeStyle = '#b7ac9a';
      context.strokeRect(0, y, PIANO_KEYBOARD_WIDTH, rowHeight);

      if (midi % 12 === 0 || midi === FIRST_MIDI_NOTE) {
        context.fillStyle = isBlackKey(midi) ? '#fffdf7' : '#29251f';
        context.font = '10px Inter, system-ui, sans-serif';
        context.textBaseline = 'middle';
        const label = midi === FIRST_MIDI_NOTE ? 'A0' : `C${Math.floor(midi / 12) - 1}`;
        context.fillText(label, 5, y + rowHeight / 2);
      }
    }

    context.strokeStyle = '#8f8474';
    context.strokeRect(0, 0, PIANO_KEYBOARD_WIDTH, height);
  }

  private drawGrid(
    gridLeft: number,
    gridWidth: number,
    rowHeight: number,
    height: number,
    windowStart: number,
  ): void {
    const context = this.context;
    context.fillStyle = '#f3efe7';
    context.fillRect(gridLeft, 0, gridWidth, height);
    context.fillStyle = 'rgba(153, 140, 119, 0.2)';
    const beforeTrackWidth = Math.max(0, Math.min(gridWidth, ((0 - windowStart) / VISIBLE_SECONDS) * gridWidth));
    const afterTrackX = Math.max(0, Math.min(gridWidth, ((this.durationSeconds - windowStart) / VISIBLE_SECONDS) * gridWidth));
    context.fillRect(gridLeft, 0, beforeTrackWidth, height);
    context.fillRect(gridLeft + afterTrackX, 0, gridWidth - afterTrackX, height);

    context.strokeStyle = 'rgba(119, 106, 88, 0.22)';
    context.lineWidth = 1;
    for (let row = 0; row <= 88; row += 1) {
      const y = Math.round(row * rowHeight) + 0.5;
      context.beginPath();
      context.moveTo(gridLeft, y);
      context.lineTo(gridLeft + gridWidth, y);
      context.stroke();
    }
    for (let second = Math.ceil(windowStart); second <= windowStart + VISIBLE_SECONDS; second += 1) {
      const x = gridLeft + ((second - windowStart) / VISIBLE_SECONDS) * gridWidth;
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
  }

  private drawFrames(
    gridLeft: number,
    gridWidth: number,
    rowHeight: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const result = this.result;
    if (result === null) {
      return;
    }

    const firstFrame = lowerBound(result.frameTimestamps, windowStart);
    const lastFrame = lowerBound(result.frameTimestamps, windowEnd + 0.001);
    const frameWidth = Math.max(1, (gridWidth / VISIBLE_SECONDS) * frameDuration(result, firstFrame));
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const x = gridLeft + ((result.frameTimestamps[frame] - windowStart) / VISIBLE_SECONDS) * gridWidth;
      for (let pitch = 0; pitch < result.pitchCount; pitch += 1) {
        const activation = result.frameProbabilities[frame * result.pitchCount + pitch];
        if (activation === 0) {
          continue;
        }
        const row = result.pitchCount - 1 - pitch;
        this.context.fillStyle = `rgba(57, 126, 151, ${activation / 255})`;
        this.context.fillRect(x, row * rowHeight, frameWidth, rowHeight);
      }
    }
  }

  private drawNoteOutlines(
    gridLeft: number,
    gridWidth: number,
    rowHeight: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    this.context.strokeStyle = 'rgba(34, 101, 125, 0.9)';
    this.context.lineWidth = 1;
    for (const block of this.noteIndex) {
      if (block.notes[0].startTimeSeconds > windowEnd) {
        return;
      }
      if (block.maximumEndTimeSeconds < windowStart) {
        continue;
      }
      for (const note of block.notes) {
        if (note.startTimeSeconds > windowEnd) {
          return;
        }
        if (note.endTimeSeconds < windowStart) {
          continue;
        }
        const row = LAST_MIDI_NOTE - note.pitchMidi;
        if (row < 0 || row >= 88) {
          continue;
        }
        const x = gridLeft + ((note.startTimeSeconds - windowStart) / VISIBLE_SECONDS) * gridWidth;
        const width = ((note.endTimeSeconds - note.startTimeSeconds) / VISIBLE_SECONDS) * gridWidth;
        this.context.strokeRect(x, row * rowHeight, Math.max(1, width), rowHeight);
      }
    }
  }

  private drawActiveKeys(rowHeight: number): void {
    const result = this.result;
    if (result === null || result.frameCount === 0) {
      return;
    }
    const frame = Math.max(
      0,
      Math.min(
        result.frameCount - 1,
        lowerBound(result.frameTimestamps, this.currentTimeSeconds) - 1,
      ),
    );
    for (let pitch = 0; pitch < result.pitchCount; pitch += 1) {
      if (result.frameProbabilities[frame * result.pitchCount + pitch] < 32) {
        continue;
      }
      const row = result.pitchCount - 1 - pitch;
      this.context.fillStyle = 'rgba(57, 126, 151, 0.82)';
      this.context.fillRect(1, row * rowHeight + 1, PIANO_KEYBOARD_WIDTH - 2, Math.max(1, rowHeight - 2));
    }
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (event.clientX < rect.left + PIANO_KEYBOARD_WIDTH) {
      return;
    }
    const x = event.clientX - rect.left - PIANO_KEYBOARD_WIDTH;
    const width = Math.max(1, rect.width - PIANO_KEYBOARD_WIDTH);
    const windowStart = this.currentTimeSeconds - VISIBLE_SECONDS * PLAYHEAD_POSITION;
    this.onSeek?.(Math.max(0, Math.min(this.durationSeconds, windowStart + (x / width) * VISIBLE_SECONDS)));
  };
}

function isBlackKey(midi: number): boolean {
  const pitchClass = midi % 12;
  return pitchClass === 1 || pitchClass === 3 || pitchClass === 6 || pitchClass === 8 || pitchClass === 10;
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

function frameDuration(result: AnalysisResult, frame: number): number {
  if (frame + 1 < result.frameTimestamps.length) {
    return result.frameTimestamps[frame + 1] - result.frameTimestamps[frame];
  }
  return 1 / 86;
}

function createNoteIndex(notes: AnalyzedNote[]): NoteIndexBlock[] {
  const sortedNotes = [...notes].sort(
    (left, right) => left.startTimeSeconds - right.startTimeSeconds,
  );
  const index: NoteIndexBlock[] = [];

  for (let start = 0; start < sortedNotes.length; start += NOTES_PER_INDEX_BLOCK) {
    const blockNotes = sortedNotes.slice(start, start + NOTES_PER_INDEX_BLOCK);
    let maximumEndTimeSeconds = 0;
    for (const note of blockNotes) {
      maximumEndTimeSeconds = Math.max(maximumEndTimeSeconds, note.endTimeSeconds);
    }
    index.push({ notes: blockNotes, maximumEndTimeSeconds });
  }

  return index;
}
