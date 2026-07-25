const TARGET_SAMPLE_RATE = 22050;
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;
const MAX_DURATION_SECONDS = 600;

export enum AudioPlayerErrorCode {
  FileTooLarge = 'file-too-large',
  DurationTooLong = 'duration-too-long',
  InvalidAudio = 'invalid-audio',
}

export class AudioPlayerError extends Error {
  public constructor(public readonly code: AudioPlayerErrorCode) {
    super(code);
    this.name = 'AudioPlayerError';
  }
}

export interface DecodedAudio {
  samples: Float32Array;
  durationSeconds: number;
}

export class AudioPlayer {
  private readonly context = new AudioContext();
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private offsetSeconds = 0;
  private startedAtContextTime = 0;
  private playing = false;

  public onStateChange: (() => void) | null = null;

  public get durationSeconds(): number {
    return this.buffer?.duration ?? 0;
  }

  public get isPlaying(): boolean {
    return this.playing;
  }

  public get currentTimeSeconds(): number {
    if (!this.playing) {
      return this.offsetSeconds;
    }

    return Math.min(
      this.durationSeconds,
      this.offsetSeconds + this.context.currentTime - this.startedAtContextTime,
    );
  }

  public async load(file: File): Promise<DecodedAudio> {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new AudioPlayerError(AudioPlayerErrorCode.FileTooLarge);
    }

    this.stopSource();

    let decodedBuffer: AudioBuffer;
    try {
      decodedBuffer = await this.context.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new AudioPlayerError(AudioPlayerErrorCode.InvalidAudio);
    }

    if (decodedBuffer.duration > MAX_DURATION_SECONDS) {
      throw new AudioPlayerError(AudioPlayerErrorCode.DurationTooLong);
    }

    this.buffer = decodedBuffer;
    this.offsetSeconds = 0;
    const samples = await this.downmixAndResample(decodedBuffer);
    this.notifyStateChange();

    return { samples, durationSeconds: decodedBuffer.duration };
  }

  public play(): void {
    if (this.buffer === null) {
      return;
    }

    if (this.offsetSeconds >= this.durationSeconds) {
      this.offsetSeconds = 0;
    }

    void this.context.resume();
    this.startSource();
  }

  public pause(): void {
    if (!this.playing) {
      return;
    }

    this.offsetSeconds = this.currentTimeSeconds;
    this.stopSource();
    this.notifyStateChange();
  }

  public seek(seconds: number): void {
    this.offsetSeconds = Math.min(this.durationSeconds, Math.max(0, seconds));
    if (this.playing) {
      this.stopSource();
      this.startSource();
      return;
    }

    this.notifyStateChange();
  }

  public reset(): void {
    this.stopSource();
    this.buffer = null;
    this.offsetSeconds = 0;
    this.notifyStateChange();
  }

  public dispose(): void {
    this.stopSource();
    void this.context.close();
  }

  private async downmixAndResample(buffer: AudioBuffer): Promise<Float32Array> {
    const frameCount = Math.ceil(buffer.duration * TARGET_SAMPLE_RATE);
    const offlineContext = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
    const source = offlineContext.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineContext.destination);
    source.start();
    const rendered = await offlineContext.startRendering();
    return rendered.getChannelData(0).slice();
  }

  private startSource(): void {
    if (this.buffer === null || this.offsetSeconds >= this.buffer.duration) {
      return;
    }

    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.context.destination);
    source.onended = () => this.handleEnded(source);
    this.source = source;
    this.startedAtContextTime = this.context.currentTime;
    this.playing = true;
    source.start(0, this.offsetSeconds);
    this.notifyStateChange();
  }

  private stopSource(): void {
    const source = this.source;
    this.source = null;
    this.playing = false;

    if (source !== null) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
  }

  private handleEnded(source: AudioBufferSourceNode): void {
    if (source !== this.source) {
      return;
    }

    source.disconnect();
    this.source = null;
    this.playing = false;
    this.offsetSeconds = this.durationSeconds;
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }
}
