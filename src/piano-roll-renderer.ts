import type { AnalyzedNote, AnalysisResult } from './analysis-types';
import { DESIGN_COLORS, instrumentColor } from './design-colors';
import { clamp, formatTime, lowerBoundBy } from './util';

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
const KEY_ACTIVATION_THRESHOLD = 168;
const MAX_ACTIVE_KEY_ALPHA = 0.8;
const PRECISE_KEY_ACTIVATION_THRESHOLD = 96;
const PRECISE_MAX_ACTIVE_KEY_ALPHA = 1;
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
  private preciseKeyHighlighting = false;
  private auditionMidi: number | null = null;
  private pinchState: PinchState | null = null;

  public onSeek: ((seconds: number) => void) | null = null;
  public onFollowChange: ((following: boolean) => void) | null = null;
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

  public setAnalysis(
    result: AnalysisResult,
    durationSeconds: number,
    preserveViewport = false,
  ): void {
    this.result = result;
    this.noteIndex = createNoteIndex(result.notes);
    this.durationSeconds = Math.max(0, durationSeconds);
    if (!preserveViewport) {
      this.centerPitchRange(result.notes);
    }
    this.render(this.currentTimeSeconds);
  }

  public clear(): void {
    this.result = null;
    this.noteIndex = [];
    this.durationSeconds = 0;
    this.currentTimeSeconds = 0;
    this.resetViewport();
  }

  public setContrast(value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    this.contrast = clamp(value, MIN_CONTRAST, MAX_CONTRAST);
    this.render(this.currentTimeSeconds);
  }

  public setPreciseKeyHighlighting(enabled: boolean): void {
    if (this.preciseKeyHighlighting === enabled) {
      return;
    }
    this.preciseKeyHighlighting = enabled;
    this.render(this.currentTimeSeconds);
  }

  public zoomTime(direction: number): void {
    if (direction === 0) {
      return;
    }
    this.setFollowing(false, false);
    this.visibleSeconds = clamp(
      this.visibleSeconds * (direction > 0 ? 0.8 : 1.25),
      MIN_VISIBLE_SECONDS,
      MAX_VISIBLE_SECONDS,
    );
    this.render(this.currentTimeSeconds);
  }

  public cyclePitchRange(): void {
    this.setFollowing(false, false);
    const center = this.lowMidi + this.visiblePitchCount / 2;
    this.pitchRangeIndex = (this.pitchRangeIndex + 1) % PITCH_RANGES.length;
    this.lowMidi = clampLowMidi(
      Math.round(center - this.visiblePitchCount / 2),
      this.visiblePitchCount,
    );
    this.pitchPanRemainder = 0;
    this.render(this.currentTimeSeconds);
  }

  public toggleFollow(): void {
    this.setFollowing(!this.follow);
  }

  public resetViewport(): void {
    this.visibleSeconds = DEFAULT_VISIBLE_SECONDS;
    this.pitchRangeIndex = DEFAULT_PITCH_RANGE_INDEX;
    this.lowMidi = DEFAULT_LOW_MIDI;
    this.pitchPanRemainder = 0;
    this.setFollowing(true, false);
    if (this.result !== null) {
      this.centerPitchRange(this.result.notes);
    }
    this.render(this.currentTimeSeconds);
  }

  public render(currentTimeSeconds: number): void {
    const previousAnchorTimeSeconds = this.anchorTimeSeconds;
    this.currentTimeSeconds = Number.isFinite(currentTimeSeconds)
      ? clamp(currentTimeSeconds, 0, this.durationSeconds)
      : 0;
    if (this.follow) {
      this.timeOffsetSeconds = 0;
    } else {
      this.timeOffsetSeconds =
        previousAnchorTimeSeconds - this.currentTimeSeconds;
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
    this.drawAuditionLane(cssWidth, rollHeight);
    this.drawPlaybackPosition(cssWidth, rollHeight);
    this.drawKeyboard(cssWidth, rollHeight, keyboardHeight);
  }

  private get visiblePitchCount(): number {
    return PITCH_RANGES[this.pitchRangeIndex];
  }

  private get anchorTimeSeconds(): number {
    return this.currentTimeSeconds + this.timeOffsetSeconds;
  }

  private setFollowing(next: boolean, shouldRender = true): void {
    const changed = this.follow !== next;
    this.follow = next;
    if (next) {
      this.timeOffsetSeconds = 0;
    }
    if (changed) {
      this.onFollowChange?.(next);
    }
    if (shouldRender) {
      this.render(this.currentTimeSeconds);
    }
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
    context.fillStyle = DESIGN_COLORS.grid;
    context.globalAlpha = 0.55;
    for (let index = 0; index < this.visiblePitchCount; index += 1) {
      const midi = this.lowMidi + index;
      if (!isBlackKey(midi)) {
        continue;
      }
      context.fillRect(index * columnWidth, 0, columnWidth, rollHeight);
    }
    context.globalAlpha = 1;
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
      lowerBoundBy(result.frameTimestamps.length, i => result.frameTimestamps[i] < windowStart) - 1,
    );
    const lastFrame = lowerBoundBy(result.frameTimestamps.length, i => result.frameTimestamps[i] < windowEnd);
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
        if (note.instrument !== undefined) {
          this.context.fillStyle = instrumentColor(note.instrument);
          this.context.strokeStyle = this.context.fillStyle;
          this.context.fillRect(
            this.pitchToX(note.pitchMidi, width),
            yTop,
            Math.max(1, columnWidth),
            Math.max(1, yBottom - yTop),
          );
        } else {
          this.context.strokeStyle = DESIGN_COLORS.note;
        }
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
    const highMidi = this.lowMidi + this.visiblePitchCount;
    context.fillStyle = DESIGN_COLORS.surface;
    context.fillRect(0, top, width, keyboardHeight);
    this.forEachVisibleWhiteKey((leftMidi, rightMidi) => {
      const x = this.pitchToX(leftMidi, width);
      const keyWidth = this.pitchToX(rightMidi, width) - x;
      context.fillStyle = DESIGN_COLORS.surface;
      context.fillRect(x, top, keyWidth + 0.5, keyboardHeight);
      context.strokeStyle = DESIGN_COLORS.grid;
      context.strokeRect(x, top, keyWidth, keyboardHeight);
    });
    this.drawActiveKeys(width, top, keyboardHeight, false);
    for (let midi = this.lowMidi; midi < highMidi; midi += 1) {
      if (!isBlackKey(midi)) {
        continue;
      }
      const x = this.pitchToX(midi, width) + columnWidth * 0.12;
      context.fillStyle = DESIGN_COLORS.text;
      context.fillRect(x, top, columnWidth * 0.76, keyboardHeight * 0.62);
    }
    this.drawActiveKeys(width, top, keyboardHeight, true);
    this.drawAuditionKey(width, top, keyboardHeight);
    context.strokeStyle = DESIGN_COLORS.text;
    context.strokeRect(0, top, width, keyboardHeight);
  }

  private drawAuditionLane(width: number, rollHeight: number): void {
    const midi = this.auditionMidi;
    if (midi === null || rollHeight <= 0 || !this.isPitchVisible(midi)) {
      return;
    }
    const columnWidth = width / this.visiblePitchCount;
    const context = this.context;
    context.save();
    context.beginPath();
    context.rect(0, 0, width, rollHeight);
    context.clip();
    context.fillStyle = DESIGN_COLORS.keyActive;
    context.globalAlpha = 0.16;
    context.fillRect(
      this.pitchToX(midi, width),
      0,
      Math.max(1, columnWidth),
      rollHeight,
    );
    context.globalAlpha = 0.55;
    context.strokeStyle = DESIGN_COLORS.keyActive;
    context.lineWidth = 1;
    const x = Math.round(this.pitchToX(midi, width)) + 0.5;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, rollHeight);
    const right = Math.round(this.pitchToX(midi, width) + columnWidth) - 0.5;
    context.moveTo(right, 0);
    context.lineTo(right, rollHeight);
    context.stroke();
    context.restore();
  }

  private drawAuditionKey(
    width: number,
    top: number,
    keyboardHeight: number,
  ): void {
    const midi = this.auditionMidi;
    if (midi === null || !this.isPitchVisible(midi)) {
      return;
    }
    const columnWidth = width / this.visiblePitchCount;
    const context = this.context;
    context.save();
    context.fillStyle = DESIGN_COLORS.keyActive;
    context.globalAlpha = 0.9;
    if (isBlackKey(midi)) {
      const x = this.pitchToX(midi, width);
      context.fillRect(
        x + columnWidth * 0.12,
        top + 1,
        columnWidth * 0.76,
        keyboardHeight * 0.62 - 2,
      );
    } else {
      const highMidi = this.lowMidi + this.visiblePitchCount;
      const leftMidi = Math.max(midi, this.lowMidi);
      const rightMidi = Math.min(nextWhiteMidi(midi), highMidi);
      const x = this.pitchToX(leftMidi, width);
      const keyWidth = this.pitchToX(rightMidi, width) - x;
      context.fillRect(x + 1, top + 1, Math.max(1, keyWidth - 2), keyboardHeight - 2);
    }
    context.restore();
  }

  private startAudition(midi: number): void {
    this.auditionMidi = midi;
    this.onPianoKeyStart?.(midi);
    this.render(this.currentTimeSeconds);
  }

  private stopAudition(): void {
    this.auditionMidi = null;
    this.onPianoKeyStop?.();
    this.render(this.currentTimeSeconds);
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
      lowerBoundBy(result.frameTimestamps.length, i => result.frameTimestamps[i] < this.currentTimeSeconds) - 1,
      0,
      result.frameCount - 1,
    );
    const columnWidth = width / this.visiblePitchCount;
    const highMidi = this.lowMidi + this.visiblePitchCount;
    this.context.fillStyle = DESIGN_COLORS.keyActive;
    for (let pitch = 0; pitch < result.pitchCount; pitch += 1) {
      const midi = FIRST_MIDI_NOTE + pitch;
      if (!this.isPitchVisible(midi) || isBlackKey(midi) !== black) {
        continue;
      }
      const activation =
        result.frameProbabilities[frame * result.pitchCount + pitch];
      if (activation < this.keyActivationThreshold) {
        continue;
      }
      const alpha = activeKeyAlpha(
        activation,
        this.keyActivationThreshold,
        this.maxActiveKeyAlpha,
      );
      this.context.globalAlpha = alpha;
      if (black) {
        const x = this.pitchToX(midi, width);
        this.context.fillRect(
          x + columnWidth * 0.12,
          top + 1,
          columnWidth * 0.76,
          keyboardHeight * 0.62 - 2,
        );
      } else {
        const leftMidi = Math.max(midi, this.lowMidi);
        const rightMidi = Math.min(nextWhiteMidi(midi), highMidi);
        const x = this.pitchToX(leftMidi, width);
        const keyWidth = this.pitchToX(rightMidi, width) - x;
        this.context.fillRect(
          x + 1,
          top + 1,
          Math.max(1, keyWidth - 2),
          keyboardHeight - 2,
        );
      }
    }
    this.context.globalAlpha = 1;
  }

  private forEachVisibleWhiteKey(
    callback: (leftMidi: number, rightMidi: number) => void,
  ): void {
    const highMidi = this.lowMidi + this.visiblePitchCount;
    const seen = new Set<number>();
    for (let midi = this.lowMidi; midi < highMidi; midi += 1) {
      const startMidi = isBlackKey(midi) ? midi - 1 : midi;
      if (seen.has(startMidi)) {
        continue;
      }
      seen.add(startMidi);
      const leftMidi = Math.max(startMidi, this.lowMidi);
      const rightMidi = Math.min(nextWhiteMidi(startMidi), highMidi);
      if (leftMidi < rightMidi) {
        callback(leftMidi, rightMidi);
      }
    }
  }

  private drawPlaybackPosition(width: number, rollHeight: number): void {
    if (rollHeight <= 0) {
      return;
    }
    const y = this.timeToY(this.currentTimeSeconds, rollHeight);
    const lineHeight = Math.min(2, rollHeight);
    const clampedY = clamp(
      y,
      lineHeight / 2,
      rollHeight - lineHeight / 2,
    );
    const direction = y < 0 ? '↑' : y > rollHeight ? '↓' : '';
    const label = `NOW ${formatTime(this.currentTimeSeconds)}${direction}`;
    const context = this.context;
    context.save();
    context.beginPath();
    context.rect(0, 0, width, rollHeight);
    context.clip();
    context.fillStyle = DESIGN_COLORS.playhead;
    context.fillRect(0, clampedY - lineHeight / 2, width, lineHeight);
    if (rollHeight >= 18) {
      context.font = '600 11px system-ui, sans-serif';
      context.textBaseline = 'middle';
      const labelWidth = Math.ceil(context.measureText(label).width) + 10;
      if (width >= labelWidth + 12) {
        const labelX = width - labelWidth - 6;
        const labelY = clamp(clampedY, 9, rollHeight - 9);
        context.beginPath();
        context.roundRect(labelX, labelY - 8, labelWidth, 16, 8);
        context.fill();
        context.fillStyle = DESIGN_COLORS.playheadText;
        context.fillText(label, labelX + 5, labelY);
      }
    }
    context.restore();
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.setFollowing(false, false);
    const rect = this.canvas.getBoundingClientRect();
    const rollHeight = Math.max(1, rect.height - this.getKeyboardHeight());
    const deltaPixels = normalizeWheelDelta(event.deltaY, event.deltaMode, rollHeight);
    if (event.ctrlKey || event.metaKey) {
      this.zoomTimeAt(
        -deltaPixels,
        clamp((event.clientY - rect.top) / rollHeight, 0, 1),
      );
    } else if (event.altKey) {
      this.zoomPitchAt(
        -deltaPixels,
        clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      );
    } else if (event.shiftKey) {
      this.panPitch(
        (deltaPixels / Math.max(1, rect.width)) * this.visiblePitchCount,
      );
    } else {
      const pitchDelta =
        normalizeWheelDelta(event.deltaX, event.deltaMode, rollHeight) /
        Math.max(1, rect.width);
      this.panPitch(pitchDelta * this.visiblePitchCount);
      this.panTime((-deltaPixels / rollHeight) * this.visibleSeconds);
    }
    this.render(this.currentTimeSeconds);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.canvas.focus({ preventScroll: true });
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
      this.startAudition(state.midi);
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
        this.stopAudition();
      }
    }
    if (this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }
    if (!state.moved) {
      return;
    }
    this.setFollowing(false, false);
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
      this.stopAudition();
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
      this.stopAudition();
    }
    this.setFollowing(false, false);
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
    this.clampTimeOffset();
    this.render(this.currentTimeSeconds);
  }

  private zoomTimeAt(deltaPixels: number, yRatio: number): void {
    const anchor =
      this.anchorTimeSeconds + (1 - yRatio) * this.visibleSeconds;
    this.visibleSeconds = clamp(
      this.visibleSeconds * Math.exp(clamp(deltaPixels, -240, 240) * 0.0018),
      MIN_VISIBLE_SECONDS,
      MAX_VISIBLE_SECONDS,
    );
    this.timeOffsetSeconds =
      anchor - this.currentTimeSeconds - (1 - yRatio) * this.visibleSeconds;
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
    const targetTime = clamp(
      this.anchorTimeSeconds + (1 - y / rollHeight) * this.visibleSeconds,
      0,
      this.durationSeconds,
    );
    this.setFollowing(false, false);
    this.onSeek?.(targetTime);
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
      this.stopAudition();
    }
  }

  private centerPitchRange(notes: AnalyzedNote[]): void {
    const span = this.resolveUsefulPitchSpan(notes);
    if (span === null) {
      this.pitchRangeIndex = DEFAULT_PITCH_RANGE_INDEX;
      this.lowMidi = DEFAULT_LOW_MIDI;
      this.pitchPanRemainder = 0;
      return;
    }
    const usefulPitchCount = span.high - span.low + 1;
    this.pitchRangeIndex = smallestFittingPitchRangeIndex(usefulPitchCount);
    const midpoint = (span.low + span.high) / 2;
    this.lowMidi = clampLowMidi(
      Math.round(midpoint - this.visiblePitchCount / 2),
      this.visiblePitchCount,
    );
    this.pitchPanRemainder = 0;
  }

  private resolveUsefulPitchSpan(
    notes: AnalyzedNote[],
  ): { low: number; high: number } | null {
    const pitches = notes
      .map(note => note.pitchMidi)
      .filter(pitch => pitch >= FIRST_MIDI_NOTE && pitch <= LAST_MIDI_NOTE)
      .sort((left, right) => left - right);
    if (pitches.length > 0) {
      return {
        low: Math.max(FIRST_MIDI_NOTE, pitches[0] - 2),
        high: Math.min(LAST_MIDI_NOTE, pitches[pitches.length - 1] + 2),
      };
    }
    return this.spanFromFrameProbabilities();
  }

  private spanFromFrameProbabilities(): { low: number; high: number } | null {
    const result = this.result;
    if (result === null || result.frameCount === 0) {
      return null;
    }
    const threshold = 48;
    let low = LAST_MIDI_NOTE + 1;
    let high = FIRST_MIDI_NOTE - 1;
    const frameStep = Math.max(1, Math.floor(result.frameCount / 240));
    for (let frame = 0; frame < result.frameCount; frame += frameStep) {
      const offset = frame * result.pitchCount;
      for (let pitch = 0; pitch < result.pitchCount; pitch += 1) {
        if (result.frameProbabilities[offset + pitch] < threshold) {
          continue;
        }
        const midi = FIRST_MIDI_NOTE + pitch;
        low = Math.min(low, midi);
        high = Math.max(high, midi);
      }
    }
    if (high < low) {
      return null;
    }
    return {
      low: Math.max(FIRST_MIDI_NOTE, low - 2),
      high: Math.min(LAST_MIDI_NOTE, high + 2),
    };
  }

  private clampTimeOffset(): void {
    this.clampTimeOffsetFor(this.currentTimeSeconds);
  }

  private clampTimeOffsetFor(timeSeconds: number): void {
    this.timeOffsetSeconds =
      clamp(timeSeconds + this.timeOffsetSeconds, 0, this.durationSeconds) -
      timeSeconds;
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

  private get keyActivationThreshold(): number {
    return this.preciseKeyHighlighting
      ? PRECISE_KEY_ACTIVATION_THRESHOLD
      : KEY_ACTIVATION_THRESHOLD;
  }

  private get maxActiveKeyAlpha(): number {
    return this.preciseKeyHighlighting
      ? PRECISE_MAX_ACTIVE_KEY_ALPHA
      : MAX_ACTIVE_KEY_ALPHA;
  }
}

function activationToAlpha(activation: number, contrast: number): number {
  const normalized = clamp(activation / 255, 0, 1);
  const floor = 0.05 + (contrast - MIN_CONTRAST) * 0.05;
  const adjusted = Math.max(0, (normalized - floor) / (1 - floor));
  return adjusted ** (1 + contrast * 0.42);
}

function activeKeyAlpha(
  activation: number,
  threshold: number,
  maximumAlpha: number,
): number {
  const normalized = clamp(
    (activation - threshold) / (255 - threshold),
    0,
    1,
  );
  return 0.3 + normalized * (maximumAlpha - 0.3);
}

function normalizeWheelDelta(
  delta: number,
  deltaMode: number,
  rollHeight: number,
): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * 16;
  }
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * rollHeight;
  }
  return delta;
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

function nextWhiteMidi(midi: number): number {
  let next = midi + 1;
  while (isBlackKey(next)) {
    next += 1;
  }
  return next;
}

function smallestFittingPitchRangeIndex(usefulPitchCount: number): number {
  for (let index = 0; index < PITCH_RANGES.length; index += 1) {
    if (PITCH_RANGES[index] >= usefulPitchCount) {
      return index;
    }
  }
  return PITCH_RANGES.length - 1;
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
