import type { AnalyzedNote, AnalysisResult } from './analysis-types';
import { DESIGN_COLORS } from './design-colors';

const FIRST_MIDI_NOTE = 21;
const LAST_MIDI_NOTE = 108;
const PIANO_KEYBOARD_WIDTH = 72;
const VISIBLE_SECONDS = 12;
const PLAYHEAD_POSITION = 0.36;
const NOTES_PER_INDEX_BLOCK = 64;
const TILE_SECONDS = 4;
const TILE_CACHE_LIMIT = 4;

type TileCanvas = HTMLCanvasElement | OffscreenCanvas;
type TileContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface NoteIndexBlock {
  notes: AnalyzedNote[];
  maximumEndTimeSeconds: number;
}

interface TemporalTile {
  canvas: TileCanvas;
  cssWidth: number;
}

export class PianoRollRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly tileCache = new Map<number, TemporalTile>();
  private result: AnalysisResult | null = null;
  private noteIndex: NoteIndexBlock[] = [];
  private durationSeconds = 0;
  private currentTimeSeconds = 0;
  private renderedCssWidth = 0;
  private renderedCssHeight = 0;
  private renderedPixelRatio = 0;
  private disposed = false;

  public onSeek: ((seconds: number) => void) | null = null;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Canvas 2D is not available');
    }

    this.context = context;
    this.resizeObserver = new ResizeObserver(() =>
      this.render(this.currentTimeSeconds),
    );
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('click', this.handleClick);
    this.render(0);
  }

  public setAnalysis(result: AnalysisResult, durationSeconds: number): void {
    if (this.disposed) {
      return;
    }
    this.result = result;
    this.noteIndex = createNoteIndex(result.notes);
    this.durationSeconds = durationSeconds;
    this.invalidateTileCache();
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
    this.invalidateTileCache();
    this.render(0);
  }

  public render(currentTimeSeconds: number): void {
    if (this.disposed) {
      return;
    }
    this.currentTimeSeconds = currentTimeSeconds;
    const { cssWidth, cssHeight, ratio } = this.syncCanvasSize();
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
      this.drawFrameTiles(
        gridLeft,
        gridWidth,
        cssHeight,
        ratio,
        windowStart,
        windowEnd,
      );
      this.drawNoteOutlines(
        gridLeft,
        gridWidth,
        rowHeight,
        windowStart,
        windowEnd,
      );
      context.restore();
      this.drawActiveKeys(rowHeight);
    }

    const playheadX = gridLeft + gridWidth * PLAYHEAD_POSITION;
    context.fillStyle = DESIGN_COLORS.playhead;
    context.fillRect(playheadX - 1, 0, 2, cssHeight);
  }

  public dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('click', this.handleClick);
    this.invalidateTileCache();
  }

  private syncCanvasSize(): {
    cssWidth: number;
    cssHeight: number;
    ratio: number;
  } {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.floor(rect.width * ratio));
    const targetHeight = Math.max(1, Math.floor(rect.height * ratio));
    const changed =
      targetWidth !== this.canvas.width ||
      targetHeight !== this.canvas.height ||
      rect.width !== this.renderedCssWidth ||
      rect.height !== this.renderedCssHeight ||
      ratio !== this.renderedPixelRatio;

    if (changed) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
      this.renderedCssWidth = rect.width;
      this.renderedCssHeight = rect.height;
      this.renderedPixelRatio = ratio;
      this.invalidateTileCache();
    }

    return { cssWidth: rect.width, cssHeight: rect.height, ratio };
  }

  private invalidateTileCache(): void {
    this.tileCache.clear();
  }

  private drawKeyboard(rowHeight: number, height: number): void {
    const context = this.context;
    for (let row = 0; row < 88; row += 1) {
      const midi = LAST_MIDI_NOTE - row;
      const y = row * rowHeight;
      context.fillStyle = isBlackKey(midi)
        ? DESIGN_COLORS.text
        : DESIGN_COLORS.surface;
      context.fillRect(0, y, PIANO_KEYBOARD_WIDTH, rowHeight + 0.5);
      context.strokeStyle = DESIGN_COLORS.grid;
      context.strokeRect(0, y, PIANO_KEYBOARD_WIDTH, rowHeight);

      if (midi % 12 === 0 || midi === FIRST_MIDI_NOTE) {
        context.fillStyle = isBlackKey(midi)
          ? DESIGN_COLORS.surface
          : DESIGN_COLORS.text;
        context.font = '10px Inter, system-ui, sans-serif';
        context.textBaseline = 'middle';
        const label =
          midi === FIRST_MIDI_NOTE
            ? 'A0'
            : `C${Math.floor(midi / 12) - 1}`;
        context.fillText(label, 5, y + rowHeight / 2);
      }
    }

    context.strokeStyle = DESIGN_COLORS.text;
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
    context.fillStyle = DESIGN_COLORS.surface;
    context.fillRect(gridLeft, 0, gridWidth, height);
    context.save();
    context.globalAlpha = 0.42;
    context.fillStyle = DESIGN_COLORS.grid;
    const beforeTrackWidth = Math.max(
      0,
      Math.min(
        gridWidth,
        ((0 - windowStart) / VISIBLE_SECONDS) * gridWidth,
      ),
    );
    const afterTrackX = Math.max(
      0,
      Math.min(
        gridWidth,
        ((this.durationSeconds - windowStart) / VISIBLE_SECONDS) * gridWidth,
      ),
    );
    context.fillRect(gridLeft, 0, beforeTrackWidth, height);
    context.fillRect(
      gridLeft + afterTrackX,
      0,
      gridWidth - afterTrackX,
      height,
    );
    context.restore();

    context.strokeStyle = DESIGN_COLORS.grid;
    context.lineWidth = 1;
    for (let row = 0; row <= 88; row += 1) {
      const y = Math.round(row * rowHeight) + 0.5;
      context.beginPath();
      context.moveTo(gridLeft, y);
      context.lineTo(gridLeft + gridWidth, y);
      context.stroke();
    }
    for (
      let second = Math.ceil(windowStart);
      second <= windowStart + VISIBLE_SECONDS;
      second += 1
    ) {
      const x =
        gridLeft +
        ((second - windowStart) / VISIBLE_SECONDS) * gridWidth;
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
  }

  private drawFrameTiles(
    gridLeft: number,
    gridWidth: number,
    cssHeight: number,
    ratio: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const visibleStart = Math.max(0, windowStart);
    const visibleEnd = Math.min(this.durationSeconds, windowEnd);
    if (visibleEnd <= visibleStart) {
      return;
    }

    const firstTile = Math.floor(visibleStart / TILE_SECONDS);
    const lastTile = Math.floor(
      Math.max(visibleStart, visibleEnd - 0.000001) / TILE_SECONDS,
    );
    for (let tileIndex = firstTile; tileIndex <= lastTile; tileIndex += 1) {
      const tile = this.getTile(
        tileIndex,
        gridWidth,
        cssHeight,
        ratio,
      );
      const tileStart = tileIndex * TILE_SECONDS;
      const x =
        gridLeft +
        ((tileStart - windowStart) / VISIBLE_SECONDS) * gridWidth;
      this.context.drawImage(
        tile.canvas,
        x,
        0,
        tile.cssWidth,
        cssHeight,
      );
    }
  }

  private getTile(
    tileIndex: number,
    gridWidth: number,
    cssHeight: number,
    ratio: number,
  ): TemporalTile {
    const cached = this.tileCache.get(tileIndex);
    if (cached !== undefined) {
      this.tileCache.delete(tileIndex);
      this.tileCache.set(tileIndex, cached);
      return cached;
    }

    const tile = this.createTile(
      tileIndex,
      gridWidth,
      cssHeight,
      ratio,
    );
    this.tileCache.set(tileIndex, tile);
    if (this.tileCache.size > TILE_CACHE_LIMIT) {
      const oldestTile = this.tileCache.keys().next().value;
      if (oldestTile !== undefined) {
        this.tileCache.delete(oldestTile);
      }
    }
    return tile;
  }

  private createTile(
    tileIndex: number,
    gridWidth: number,
    cssHeight: number,
    ratio: number,
  ): TemporalTile {
    const result = this.result;
    const cssWidth = (gridWidth / VISIBLE_SECONDS) * TILE_SECONDS;
    const width = Math.max(1, Math.ceil(cssWidth * ratio));
    const height = Math.max(1, Math.ceil(cssHeight * ratio));
    const canvas = createTileCanvas(width, height);
    const context = getTileContext(canvas);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    if (result === null) {
      return { canvas, cssWidth };
    }

    const tileStart = tileIndex * TILE_SECONDS;
    const tileEnd = tileStart + TILE_SECONDS;
    const firstFrame = lowerBound(result.frameTimestamps, tileStart);
    const lastFrame = lowerBound(result.frameTimestamps, tileEnd);
    const rowHeight = cssHeight / 88;
    const pixelsPerSecond = cssWidth / TILE_SECONDS;
    context.fillStyle = DESIGN_COLORS.note;

    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const x = (result.frameTimestamps[frame] - tileStart) * pixelsPerSecond;
      const frameWidth = Math.max(
        1,
        pixelsPerSecond * frameDuration(result, frame),
      );
      for (let pitch = 0; pitch < result.pitchCount; pitch += 1) {
        const activation =
          result.frameProbabilities[frame * result.pitchCount + pitch];
        if (activation === 0) {
          continue;
        }
        const row = result.pitchCount - 1 - pitch;
        context.globalAlpha = activation / 255;
        context.fillRect(x, row * rowHeight, frameWidth, rowHeight);
      }
    }
    context.globalAlpha = 1;

    return { canvas, cssWidth };
  }

  private drawNoteOutlines(
    gridLeft: number,
    gridWidth: number,
    rowHeight: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    this.context.strokeStyle = DESIGN_COLORS.note;
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
        const x =
          gridLeft +
          ((note.startTimeSeconds - windowStart) / VISIBLE_SECONDS) *
            gridWidth;
        const width =
          ((note.endTimeSeconds - note.startTimeSeconds) / VISIBLE_SECONDS) *
          gridWidth;
        this.context.strokeRect(
          x,
          row * rowHeight,
          Math.max(1, width),
          rowHeight,
        );
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
    this.context.fillStyle = DESIGN_COLORS.note;
    this.context.save();
    this.context.globalAlpha = 0.82;
    for (let pitch = 0; pitch < result.pitchCount; pitch += 1) {
      if (
        result.frameProbabilities[frame * result.pitchCount + pitch] < 32
      ) {
        continue;
      }
      const row = result.pitchCount - 1 - pitch;
      this.context.fillRect(
        1,
        row * rowHeight + 1,
        PIANO_KEYBOARD_WIDTH - 2,
        Math.max(1, rowHeight - 2),
      );
    }
    this.context.restore();
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (event.clientX < rect.left + PIANO_KEYBOARD_WIDTH) {
      return;
    }
    const x = event.clientX - rect.left - PIANO_KEYBOARD_WIDTH;
    const width = Math.max(1, rect.width - PIANO_KEYBOARD_WIDTH);
    const windowStart =
      this.currentTimeSeconds - VISIBLE_SECONDS * PLAYHEAD_POSITION;
    this.onSeek?.(
      Math.max(
        0,
        Math.min(
          this.durationSeconds,
          windowStart + (x / width) * VISIBLE_SECONDS,
        ),
      ),
    );
  };
}

function createTileCanvas(width: number, height: number): TileCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function getTileContext(canvas: TileCanvas): TileContext {
  const context = canvas.getContext('2d') as TileContext | null;
  if (context === null) {
    throw new Error('Tile Canvas 2D is not available');
  }
  return context;
}

function isBlackKey(midi: number): boolean {
  const pitchClass = midi % 12;
  return (
    pitchClass === 1 ||
    pitchClass === 3 ||
    pitchClass === 6 ||
    pitchClass === 8 ||
    pitchClass === 10
  );
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
  return 1 / ANNOTATIONS_PER_SECOND;
}

function createNoteIndex(notes: AnalyzedNote[]): NoteIndexBlock[] {
  const sortedNotes = [...notes].sort(
    (left, right) => left.startTimeSeconds - right.startTimeSeconds,
  );
  const index: NoteIndexBlock[] = [];

  for (
    let start = 0;
    start < sortedNotes.length;
    start += NOTES_PER_INDEX_BLOCK
  ) {
    const blockNotes = sortedNotes.slice(
      start,
      start + NOTES_PER_INDEX_BLOCK,
    );
    let maximumEndTimeSeconds = 0;
    for (const note of blockNotes) {
      maximumEndTimeSeconds = Math.max(
        maximumEndTimeSeconds,
        note.endTimeSeconds,
      );
    }
    index.push({ notes: blockNotes, maximumEndTimeSeconds });
  }

  return index;
}

const ANNOTATIONS_PER_SECOND = 86;
