import { DESIGN_COLORS } from './design-colors';

const MAX_PEAK_COLUMNS = 1200;
const PLAYHEAD_WIDTH_PX = 2;
const MIN_BAR_HEIGHT_PX = 2;

export class WaveformTimeline {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private peaks = new Float32Array();
  private durationSeconds = 0;
  private currentTimeSeconds = 0;
  private disposed = false;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Waveform canvas does not support 2D rendering');
    }
    this.context = context;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  public setSamples(samples: Float32Array, durationSeconds: number): void {
    if (this.disposed) {
      return;
    }

    this.durationSeconds = Math.max(0, durationSeconds);
    this.currentTimeSeconds = 0;
    const columnCount = Math.min(MAX_PEAK_COLUMNS, samples.length);
    const peaks = new Float32Array(columnCount);

    for (let column = 0; column < columnCount; column += 1) {
      const start = Math.floor((column * samples.length) / columnCount);
      const end = Math.floor(((column + 1) * samples.length) / columnCount);
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        peak = Math.max(peak, Math.abs(samples[sampleIndex] ?? 0));
      }
      peaks[column] = peak;
    }

    this.peaks = peaks;
    this.draw();
  }

  public setCurrentTime(seconds: number): void {
    if (this.disposed) {
      return;
    }

    this.currentTimeSeconds = Math.min(this.durationSeconds, Math.max(0, seconds));
    this.draw();
  }

  public clear(): void {
    if (this.disposed) {
      return;
    }

    this.peaks = new Float32Array();
    this.durationSeconds = 0;
    this.currentTimeSeconds = 0;
    this.draw();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.resizeObserver.disconnect();
    this.peaks = new Float32Array();
  }

  private resize(): void {
    if (this.disposed) {
      return;
    }

    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.round(this.canvas.clientWidth * pixelRatio);
    const height = Math.round(this.canvas.clientHeight * pixelRatio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.draw();
  }

  private draw(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const pixelRatio = window.devicePixelRatio || 1;
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.context.clearRect(0, 0, width, height);

    if (width <= 0 || height <= 0 || this.peaks.length === 0) {
      return;
    }

    const columnWidth = width / this.peaks.length;
    const gap = Math.min(2, Math.max(1, columnWidth * 0.2));
    const barWidth = Math.max(1, columnWidth - gap);
    const midpoint = height / 2;
    const playedWidth = this.durationSeconds > 0
      ? (this.currentTimeSeconds / this.durationSeconds) * width
      : 0;

    for (let column = 0; column < this.peaks.length; column += 1) {
      const barHeight = Math.max(MIN_BAR_HEIGHT_PX, this.peaks[column] * height);
      const x = column * columnWidth + (columnWidth - barWidth) / 2;
      const y = midpoint - barHeight / 2;
      this.context.fillStyle = x + barWidth / 2 <= playedWidth
        ? DESIGN_COLORS.playhead
        : DESIGN_COLORS.waveform;
      this.context.beginPath();
      this.context.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, 2));
      this.context.fill();
    }

    const playheadX = Math.min(width, Math.max(0, playedWidth));
    this.context.fillStyle = DESIGN_COLORS.playhead;
    this.context.fillRect(playheadX - PLAYHEAD_WIDTH_PX / 2, 0, PLAYHEAD_WIDTH_PX, height);
  }
}
