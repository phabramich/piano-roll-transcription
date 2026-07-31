import type { AnalyzedNote, AnalysisResult } from './analysis-types';
import { DESIGN_COLORS } from './design-colors';

const FIRST_MIDI_NOTE = 21;
const LAST_MIDI_NOTE = 108;
const DESKTOP_KEYBOARD_HEIGHT = 96;
const MOBILE_KEYBOARD_HEIGHT = 78;
const MOBILE_BREAKPOINT_PX = 700;
const MIN_VISIBLE_SECONDS = 2;
const MAX_VISIBLE_SECONDS = 20;
const DEFAULT_VISIBLE_SECONDS = 12;
const PITCH_RANGES = [36, 48, 60, 84] as const;
const DEFAULT_PITCH_RANGE_INDEX = 2;
const DEFAULT_LOW_MIDI = 36;
const HOLD_DELAY_MS = 200;
const DRAG_THRESHOLD_PX = 8;
const KEY_ACTIVATION_THRESHOLD = 14;
const DEFAULT_CONTRAST = 1.4;
const MIN_CONTRAST = 0.7;
const MAX_CONTRAST = 2.2;
const NOTES_PER_INDEX_BLOCK = 64;

interface NoteIndexBlock {
  notes: AnalyzedNote[];
  maximumEndTimeSeconds: number;
}

interface PointerState {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  midi: number;
  holdTimeoutId: number;
  auditioning: boolean;
  moved: boolean;
}

interface PinchState {
  distanceX: number;
  distanceY: number;
  visibleSeconds: number;
  visiblePitchCount: number;
  lowMidi: number;
  timeOffsetSeconds: number;
  centerX: number;
  centerY: number;
}

export class PianoRollRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly pointers = new Map<number, PointerState>();
  private result: AnalysisResult | null = null;
  private noteIndex: NoteIndexBlock[] = [];
  private durationSeconds = 0;
  private currentTimeSeconds = 0;
  private renderedCssWidth = 0;
  private renderedCssHeight = 0;
  private renderedPixelRatio = 0;
  private contrast = DEFAULT_CONTRAST;
  private visibleSeconds = DEFAULT_VISIBLE_SECONDS;
  private pitchRangeIndex = DEFAULT_PITCH_RANGE_INDEX;
  private lowMidi = DEFAULT_LOW_MIDI;
  private pitchPanRemainder = 0;
  private timeOffsetSeconds = 0;
  private follow = true;
  private pinchState: PinchState | null = null;
  private disposed = false;

  public onSeek: ((seconds: number) => void) | null = null;
  public onPianoKeyPrepare: (() => void) | null = null;
  public onPianoKeyStart: ((midi: number) => void) | null = null;
  public onPianoKeyStop: (() => void) | null = null;

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
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerEnd);
    canvas.addEventListener('pointercancel', this.handlePointerEnd);
    canvas.addEventListener('lostpointercapture', this.handlePointerEnd);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.render(0);
  }

  public setAnalysis(result: AnalysisResult, durationSeconds: number): void {
    if (this.disposed) {
      return;
    }
    this.result = result;
    this.noteIndex = createNoteIndex(result.notes);
    this.durationSeconds = Math.max(0, durationSeconds);
    this.centerPitchRange(result.notes);
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
    this.resetViewport();
  }

  public setContrast(value: number): void {
    if (this.disposed || !Number.isFinite(value)) {
      return;
    }
    this.contrast = clamp(value, MIN_CONTRAST, MAX_CONTRAST);
    this.render(this.currentTimeSeconds);
  }

  public zoomTime(direction: number): void {
    if (this.disposed || direction === 0) {
      return;
    }
    this.visibleSeconds = clamp(
      this.visibleSeconds * (direction > 0 ? 0.8 : 1.25),
      MIN_VISIBLE_SECONDS,
      MAX_VISIBLE_SECONDS,
    );
    this.render(this.currentTimeSeconds);
  }

  public cyclePitchRange(): void {
    if (this.disposed) {
      return;
    }
    const center = this.lowMidi + this.visiblePitchCount / 2;
    this.pitchRangeIndex = (this.pitchRangeIndex + 1) % PITCH_RANGES.length;
    this.lowMidi = clampLowMidi(
      Math.round(center - this.visiblePitchCount / 2),
      this.visiblePitchCount,
    );
    this.pitchPanRemainder = 0;
    this.render(this.currentTimeSeconds);
  }

  public followPlayback(): void {
    if (this.disposed) {
      return;
    }
    this.follow = true;
    this.timeOffsetSeconds = 0;
    this.render(this.currentTimeSeconds);
  }

  public resetViewport(): void {
    if (this.disposed) {
      return;
    }
    this.visibleSeconds = DEFAULT_VISIBLE_SECONDS;
    this.pitchRangeIndex = DEFAULT_PITCH_RANGE_INDEX;
    this.lowMidi = DEFAULT_LOW_MIDI;
    this.pitchPanRemainder = 0;
    this.follow = true;
    this.timeOffsetSeconds = 0;
    if (this.result !== null) {
      this.centerPitchRange(this.result.notes);
    }
    this.render(this.currentTimeSeconds);
  }

  public render(currentTimeSeconds: number): void {
    if (this.disposed) {
      return;
    }
    this.currentTimeSeconds = Number.isFinite(currentTimeSeconds)
      ? clamp(currentTimeSeconds, 0, this.durationSeconds)
      : 0;
    if (this.follow) {
      this.timeOffsetSeconds = 0;
    } else {
      this.clampTimeOffset();
    }
    const { cssWidth, cssHeight, ratio } = this.syncCanvasSize();
    const keyboardHeight = this.getKeyboardHeight();
    const rollHeight = Math.max(0, cssHeight - keyboardHeight);
    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    this.drawGrid(cssWidth, rollHeight);
    if (this.result !== null && rollHeight > 0) {
      context.save();
      context.beginPath();
      context.rect(0, 0, cssWidth, rollHeight);
      context.clip();
      this.drawFrameProbabilities(cssWidth, rollHeight);
      this.drawNoteOutlines(cssWidth, rollHeight);
      context.restore();
    }
    this.drawKeyboard(cssWidth, rollHeight, keyboardHeight);
    this.drawPlayhead(cssWidth, rollHeight);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerEnd);
    this.canvas.removeEventListener('pointercancel', this.handlePointerEnd);
    this.canvas.removeEventListener(
      'lostpointercapture',
      this.handlePointerEnd,
    );
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.cancelPointers();
  }

  private get visiblePitchCount(): number {
    return PITCH_RANGES[this.pitchRangeIndex];
  }

  private get anchorTimeSeconds(): number {
    return this.currentTimeSeconds + this.timeOffsetSeconds;
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
    if (
      targetWidth !== this.canvas.width ||
      targetHeight !== this.canvas.height ||
      rect.width !== this.renderedCssWidth ||
      rect.height !== this.renderedCssHeight ||
      ratio !== this.renderedPixelRatio
    ) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
      this.renderedCssWidth = rect.width;
      this.renderedCssHeight = rect.height;
      this.renderedPixelRatio = ratio;
    }
    return { cssWidth: rect.width, cssHeight: rect.height, ratio };
  }

  private drawGrid(width: number, rollHeight: number): void {
    const context = this.context;
    context.fillStyle = DESIGN_COLORS.surface;
    context.fillRect(0, 0, width, rollHeight);
    const columnWidth = width / this.visiblePitchCount;
    context.strokeStyle = DESIGN_COLORS.grid;
    context.lineWidth = 1;
    for (let pitch = 0; pitch <= this.visiblePitchCount; pitch += 1) {
      const x = Math.round(pitch * columnWidth) + 0.5;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, rollHeight);
      context.stroke();
    }
    const start = this.anchorTimeSeconds;
    for (
      let second = Math.ceil(start);
      second <= start + this.visibleSeconds;
      second += 1
    ) {
      const y = this.timeToY(second, rollHeight);
      context.beginPath();
      context.moveTo(0, Math.round(y) + 0.5);
      context.lineTo(width, Math.round(y) + 0.5);
      context.stroke();
    }
    context.save();
    context.globalAlpha = 0.35;
    context.fillStyle = DESIGN_COLORS.grid;
    const beforeTrackY = this.timeToY(0, rollHeight);
    if (beforeTrackY < rollHeight) {
      context.fillRect(0, Math.max(0, beforeTrackY), width, rollHeight);
    }
    const afterTrackY = this.timeToY(this.durationSeconds, rollHeight);
    if (afterTrackY > 0) {
      context.fillRect(0, 0, width, Math.min(rollHeight, afterTrackY));
    }
    context.restore();
  }

  private drawFrameProbabilities(width: number, rollHeight: number): void {
    const result = this.result;
    if (result === null || result.frameCount === 0) {
      return;
    }
    const windowStart = this.anchorTimeSeconds;
    const windowEnd = windowStart + this.visibleSeconds;
    const firstFrame = Math.max(
      0,
      lowerBound(result.frameTimestamps, windowStart) - 1,
    );
    const lastFrame = lowerBound(result.frameTimestamps, windowEnd);
    const columnWidth = width / this.visiblePitchCount;
    this.context.fillStyle = DESIGN_COLORS.note;
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const frameStart = result.frameTimestamps[frame];
      const frameEnd = frameStart + frameDuration(result, frame);
      const yTop = this.timeToY(frameEnd, rollHeight);
      const yBottom = this.timeToY(frameStart, rollHeight);
      for (let pitch = 0; pitch < result.pitchCount; pitch += 1) {
        const midi = FIRST_MIDI_NOTE + pitch;
        if (!this.isPitchVisible(midi)) {
          continue;
        }
        const activation =
          result.frameProbabilities[frame * result.pitchCount + pitch];
        if (activation === 0) {
          continue;
        }
        this.context.globalAlpha = activationToAlpha(
          activation,
          this.contrast,
        );
        this.context.fillRect(
          this.pitchToX(midi, width),
          yTop,
          Math.max(1, columnWidth),
          Math.max(1, yBottom - yTop),
        );
      }
    }
    this.context.globalAlpha = 1;
  }

  private drawNoteOutlines(width: number, rollHeight: number): void {
    const windowStart = this.anchorTimeSeconds;
    const windowEnd = windowStart + this.visibleSeconds;
    const columnWidth = width / this.visiblePitchCount;
    this.context.strokeStyle = DESIGN_COLORS.note;
    this.context.lineWidth = 1.25;
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
        if (
          note.endTimeSeconds < windowStart ||
          !this.isPitchVisible(note.pitchMidi)
        ) {
          continue;
        }
        const yTop = this.timeToY(note.endTimeSeconds, rollHeight);
        const yBottom = this.timeToY(note.startTimeSeconds, rollHeight);
        this.context.strokeRect(
          this.pitchToX(note.pitchMidi, width) + 0.5,
          yTop,
          Math.max(1, columnWidth - 1),
          Math.max(1, yBottom - yTop),
        );
      }
    }
  }

  private drawKeyboard(
    width: number,
    top: number,
    keyboardHeight: number,
  ): void {
    const context = this.context;
    const columnWidth = width / this.visiblePitchCount;
    context.fillStyle = DESIGN_COLORS.surface;
    context.fillRect(0, top, width, keyboardHeight);
    for (let index = 0; index < this.visiblePitchCount; index += 1) {
      const midi = this.lowMidi + index;
      if (isBlackKey(midi)) {
        continue;
      }
      const x = index * columnWidth;
      context.fillStyle = DESIGN_COLORS.surface;
      context.fillRect(x, top, columnWidth + 0.5, keyboardHeight);
      context.strokeStyle = DESIGN_COLORS.grid;
      context.strokeRect(x, top, columnWidth, keyboardHeight);
    }
    this.drawActiveKeys(width, top, keyboardHeight, false);
    for (let index = 0; index < this.visiblePitchCount; index += 1) {
      const midi = this.lowMidi + index;
      if (!isBlackKey(midi)) {
        continue;
      }
      const x = index * columnWidth + columnWidth * 0.12;
      context.fillStyle = DESIGN_COLORS.text;
      context.fillRect(x, top, columnWidth * 0.76, keyboardHeight * 0.62);
    }
    this.drawActiveKeys(width, top, keyboardHeight, true);
    context.strokeStyle = DESIGN_COLORS.text;
    context.strokeRect(0, top, width, keyboardHeight);
  }

  private drawActiveKeys(
    width: number,
    top: number,
    keyboardHeight: number,
    black: boolean,
  ): void {
    const result = this.result;
    if (result === null || result.frameCount === 0) {
      return;
    }
    const frame = clamp(
      lowerBound(result.frameTimestamps, this.currentTimeSeconds) - 1,
      0,
      result.frameCount - 1,
    );
    const columnWidth = width / this.visiblePitchCount;
    this.context.fillStyle = DESIGN_COLORS.note;
    for (let pitch = 0; pitch < result.pitchCount; pitch += 1) {
      const midi = FIRST_MIDI_NOTE + pitch;
      if (!this.isPitchVisible(midi) || isBlackKey(midi) !== black) {
        continue;
      }
      const activation =
        result.frameProbabilities[frame * result.pitchCount + pitch];
      if (activation < KEY_ACTIVATION_THRESHOLD) {
        continue;
      }
      const alpha = activationToAlpha(activation, this.contrast);
      const x = this.pitchToX(midi, width);
      this.context.globalAlpha = 0.3 + alpha * 0.7;
      this.context.fillRect(
        x + (black ? columnWidth * 0.12 : 1),
        top + 1,
        black ? columnWidth * 0.76 : Math.max(1, columnWidth - 2),
        (black ? keyboardHeight * 0.62 : keyboardHeight) - 2,
      );
    }
    this.context.globalAlpha = 1;
  }

  private drawPlayhead(width: number, rollHeight: number): void {
    this.context.fillStyle = DESIGN_COLORS.playhead;
    this.context.fillRect(0, Math.max(0, rollHeight - 2), width, 2);
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const rollHeight = Math.max(1, rect.height - this.getKeyboardHeight());
    if (event.ctrlKey || event.metaKey) {
      this.zoomTimeAt(
        event.deltaY,
        clamp((event.clientY - rect.top) / rollHeight, 0, 1),
      );
    } else if (event.altKey) {
      this.zoomPitchAt(
        event.deltaY,
        clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      );
    } else {
      const pitchDelta = event.deltaX / Math.max(1, rect.width);
      this.panPitch(pitchDelta * this.visiblePitchCount);
      this.panTime((event.deltaY / rollHeight) * this.visibleSeconds);
    }
    this.render(this.currentTimeSeconds);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.setPointerCapture(event.pointerId);
    this.onPianoKeyPrepare?.();
    const state: PointerState = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      midi: this.clientXToMidi(event.clientX, rect),
      holdTimeoutId: 0,
      auditioning: false,
      moved: false,
    };
    state.holdTimeoutId = window.setTimeout(() => {
      if (this.pointers.size !== 1 || state.moved) {
        return;
      }
      state.auditioning = true;
      this.onPianoKeyStart?.(state.midi);
    }, HOLD_DELAY_MS);
    this.pointers.set(event.pointerId, state);
    if (this.pointers.size === 2) {
      this.startPinch();
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const state = this.pointers.get(event.pointerId);
    if (state === undefined) {
      return;
    }
    event.preventDefault();
    const previousX = state.x;
    const previousY = state.y;
    state.x = event.clientX;
    state.y = event.clientY;
    if (
      Math.hypot(state.x - state.startX, state.y - state.startY) >=
      DRAG_THRESHOLD_PX
    ) {
      state.moved = true;
      window.clearTimeout(state.holdTimeoutId);
      if (state.auditioning) {
        state.auditioning = false;
        this.onPianoKeyStop?.();
      }
    }
    if (this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }
    if (!state.moved) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const rollHeight = Math.max(1, rect.height - this.getKeyboardHeight());
    this.panPitch(
      -((state.x - previousX) / Math.max(1, rect.width)) *
        this.visiblePitchCount,
    );
    this.panTime(
      ((state.y - previousY) / rollHeight) * this.visibleSeconds,
    );
    this.render(this.currentTimeSeconds);
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    const state = this.pointers.get(event.pointerId);
    if (state === undefined) {
      return;
    }
    window.clearTimeout(state.holdTimeoutId);
    if (state.auditioning) {
      this.onPianoKeyStop?.();
    }
    const wasPinching = this.pinchState !== null;
    this.pointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (
      event.type === 'pointerup' &&
      !state.moved &&
      !state.auditioning &&
      !wasPinching
    ) {
      this.seekAt(event.clientY);
    }
    this.pinchState = null;
    if (this.pointers.size === 1) {
      const remaining = [...this.pointers.values()][0];
      remaining.startX = remaining.x;
      remaining.startY = remaining.y;
      remaining.moved = true;
    }
  };

  private readonly handleWindowBlur = (): void => {
    this.cancelPointers();
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.cancelPointers();
    }
  };

  private startPinch(): void {
    const [first, second] = [...this.pointers.values()];
    window.clearTimeout(first.holdTimeoutId);
    window.clearTimeout(second.holdTimeoutId);
    first.moved = true;
    second.moved = true;
    if (first.auditioning || second.auditioning) {
      first.auditioning = false;
      second.auditioning = false;
      this.onPianoKeyStop?.();
    }
    this.pinchState = {
      distanceX: Math.max(20, Math.abs(second.x - first.x)),
      distanceY: Math.max(20, Math.abs(second.y - first.y)),
      visibleSeconds: this.visibleSeconds,
      visiblePitchCount: this.visiblePitchCount,
      lowMidi: this.lowMidi,
      timeOffsetSeconds: this.timeOffsetSeconds,
      centerX: (first.x + second.x) / 2,
      centerY: (first.y + second.y) / 2,
    };
  }

  private updatePinch(): void {
    const pinch = this.pinchState;
    if (pinch === null || this.pointers.size < 2) {
      return;
    }
    const [first, second] = [...this.pointers.values()];
    const rect = this.canvas.getBoundingClientRect();
    const rollHeight = Math.max(1, rect.height - this.getKeyboardHeight());
    const distanceX = Math.max(20, Math.abs(second.x - first.x));
    const distanceY = Math.max(20, Math.abs(second.y - first.y));
    const centerX = (first.x + second.x) / 2;
    const centerY = (first.y + second.y) / 2;
    const nextSeconds = clamp(
      pinch.visibleSeconds * (pinch.distanceY / distanceY),
      MIN_VISIBLE_SECONDS,
      MAX_VISIBLE_SECONDS,
    );
    const desiredPitchCount = clamp(
      pinch.visiblePitchCount * (pinch.distanceX / distanceX),
      PITCH_RANGES[0],
      PITCH_RANGES[PITCH_RANGES.length - 1],
    );
    this.pitchRangeIndex = nearestPitchRangeIndex(desiredPitchCount);
    const pitchAnchor =
      pinch.lowMidi +
      ((pinch.centerX - rect.left) / Math.max(1, rect.width)) *
        pinch.visiblePitchCount;
    this.lowMidi = clampLowMidi(
      Math.round(
        pitchAnchor -
          ((centerX - rect.left) / Math.max(1, rect.width)) *
            this.visiblePitchCount,
      ),
      this.visiblePitchCount,
    );
    this.pitchPanRemainder = 0;
    const timeAnchor =
      this.currentTimeSeconds +
      pinch.timeOffsetSeconds +
      (1 - clamp((pinch.centerY - rect.top) / rollHeight, 0, 1)) *
        pinch.visibleSeconds;
    this.visibleSeconds = nextSeconds;
    this.timeOffsetSeconds =
      timeAnchor -
      this.currentTimeSeconds -
      (1 - clamp((centerY - rect.top) / rollHeight, 0, 1)) *
        this.visibleSeconds;
    this.follow = false;
    this.clampTimeOffset();
    this.render(this.currentTimeSeconds);
  }

  private zoomTimeAt(delta: number, yRatio: number): void {
    const anchor =
      this.anchorTimeSeconds + (1 - yRatio) * this.visibleSeconds;
    this.visibleSeconds = clamp(
      this.visibleSeconds * (delta > 0 ? 1.12 : 0.89),
      MIN_VISIBLE_SECONDS,
      MAX_VISIBLE_SECONDS,
    );
    this.timeOffsetSeconds =
      anchor - this.currentTimeSeconds - (1 - yRatio) * this.visibleSeconds;
    this.follow = false;
    this.clampTimeOffset();
  }

  private zoomPitchAt(delta: number, xRatio: number): void {
    const anchor = this.lowMidi + xRatio * this.visiblePitchCount;
    const nextIndex = clamp(
      this.pitchRangeIndex + (delta > 0 ? 1 : -1),
      0,
      PITCH_RANGES.length - 1,
    );
    this.pitchRangeIndex = nextIndex;
    this.lowMidi = clampLowMidi(
      Math.round(anchor - xRatio * this.visiblePitchCount),
      this.visiblePitchCount,
    );
    this.pitchPanRemainder = 0;
  }

  private panTime(deltaSeconds: number): void {
    if (Math.abs(deltaSeconds) < 0.0001) {
      return;
    }
    this.timeOffsetSeconds += deltaSeconds;
    this.follow = false;
    this.clampTimeOffset();
  }

  private panPitch(deltaPitches: number): void {
    if (!Number.isFinite(deltaPitches) || deltaPitches === 0) {
      return;
    }
    const nextLowMidi = clampLowMidi(
      this.lowMidi + this.pitchPanRemainder + deltaPitches,
      this.visiblePitchCount,
    );
    this.lowMidi = Math.round(nextLowMidi);
    this.pitchPanRemainder = nextLowMidi - this.lowMidi;
  }

  private seekAt(clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const rollHeight = Math.max(1, rect.height - this.getKeyboardHeight());
    const y = clientY - rect.top;
    if (y < 0 || y > rollHeight) {
      return;
    }
    const time =
      this.anchorTimeSeconds + (1 - y / rollHeight) * this.visibleSeconds;
    this.onSeek?.(clamp(time, 0, this.durationSeconds));
  }

  private cancelPointers(): void {
    let shouldStop = false;
    for (const state of this.pointers.values()) {
      window.clearTimeout(state.holdTimeoutId);
      shouldStop ||= state.auditioning;
      if (this.canvas.hasPointerCapture(state.id)) {
        this.canvas.releasePointerCapture(state.id);
      }
    }
    this.pointers.clear();
    this.pinchState = null;
    if (shouldStop) {
      this.onPianoKeyStop?.();
    }
  }

  private centerPitchRange(notes: AnalyzedNote[]): void {
    const pitches = notes
      .map(note => note.pitchMidi)
      .filter(pitch => pitch >= FIRST_MIDI_NOTE && pitch <= LAST_MIDI_NOTE)
      .sort((left, right) => left - right);
    if (pitches.length === 0) {
      this.pitchRangeIndex = DEFAULT_PITCH_RANGE_INDEX;
      this.lowMidi = DEFAULT_LOW_MIDI;
      this.pitchPanRemainder = 0;
      return;
    }
    const usefulPitchCount = pitches[pitches.length - 1] - pitches[0] + 1;
    if (usefulPitchCount > this.visiblePitchCount) {
      this.pitchRangeIndex = DEFAULT_PITCH_RANGE_INDEX;
      this.lowMidi = DEFAULT_LOW_MIDI;
      this.pitchPanRemainder = 0;
      return;
    }
    const median = pitches[Math.floor(pitches.length / 2)];
    this.lowMidi = clampLowMidi(
      Math.round(median - this.visiblePitchCount / 2),
      this.visiblePitchCount,
    );
    this.pitchPanRemainder = 0;
  }

  private clampTimeOffset(): void {
    this.timeOffsetSeconds =
      clamp(
        this.currentTimeSeconds + this.timeOffsetSeconds,
        0,
        this.durationSeconds,
      ) - this.currentTimeSeconds;
  }

  private timeToY(timeSeconds: number, rollHeight: number): number {
    return (
      rollHeight -
      ((timeSeconds - this.anchorTimeSeconds) / this.visibleSeconds) *
        rollHeight
    );
  }

  private pitchToX(midi: number, width: number): number {
    return ((midi - this.lowMidi) / this.visiblePitchCount) * width;
  }

  private isPitchVisible(midi: number): boolean {
    return midi >= this.lowMidi && midi < this.lowMidi + this.visiblePitchCount;
  }

  private clientXToMidi(clientX: number, rect: DOMRect): number {
    const ratio = clamp(
      (clientX - rect.left) / Math.max(1, rect.width),
      0,
      0.999999,
    );
    return clamp(
      this.lowMidi + Math.floor(ratio * this.visiblePitchCount),
      FIRST_MIDI_NOTE,
      LAST_MIDI_NOTE,
    );
  }

  private getKeyboardHeight(): number {
    return window.innerWidth <= MOBILE_BREAKPOINT_PX
      ? MOBILE_KEYBOARD_HEIGHT
      : DESKTOP_KEYBOARD_HEIGHT;
  }
}

function activationToAlpha(activation: number, contrast: number): number {
  const normalized = clamp(activation / 255, 0, 1);
  const floor = 0.05 + (contrast - MIN_CONTRAST) * 0.05;
  const adjusted = Math.max(0, (normalized - floor) / (1 - floor));
  return adjusted ** (1 + contrast * 0.42);
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampLowMidi(lowMidi: number, pitchCount: number): number {
  return clamp(
    lowMidi,
    FIRST_MIDI_NOTE,
    LAST_MIDI_NOTE - pitchCount + 1,
  );
}

function nearestPitchRangeIndex(value: number): number {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < PITCH_RANGES.length; index += 1) {
    const distance = Math.abs(PITCH_RANGES[index] - value);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }
  return closestIndex;
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
  for (
    let start = 0;
    start < sortedNotes.length;
    start += NOTES_PER_INDEX_BLOCK
  ) {
    const blockNotes = sortedNotes.slice(start, start + NOTES_PER_INDEX_BLOCK);
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
