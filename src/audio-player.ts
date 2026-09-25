const TARGET_SAMPLE_RATE = 22050;
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;
const MAX_DURATION_SECONDS = 600;
const MIN_PLAYBACK_RATE = 0.2;
const MAX_PLAYBACK_RATE = 1;

export enum AudioPlayerErrorCode {
  Cancelled = 'cancelled',
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

type PitchPreservingMediaElement = HTMLAudioElement & {
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

export class AudioPlayer {
  private readonly context = new AudioContext();
  private readonly element: PitchPreservingMediaElement = new Audio();
  private objectUrl: string | null = null;
  private duration = 0;
  private playing = false;
  private loadToken = 0;
  private playToken = 0;

  public onStateChange: (() => void) | null = null;

  public constructor() {
    this.element.preservesPitch = true;
    this.element.mozPreservesPitch = true;
    this.element.webkitPreservesPitch = true;
    this.element.addEventListener('ended', () => {
      this.playToken += 1;
      this.playing = false;
      this.notifyStateChange();
    });
  }

  public get durationSeconds(): number {
    return this.duration;
  }

  public get isPlaying(): boolean {
    return this.playing;
  }

  public get currentTimeSeconds(): number {
    return Math.min(this.durationSeconds, this.element.currentTime);
  }

  public async load(file: File): Promise<DecodedAudio> {
    const loadToken = ++this.loadToken;
    this.playToken += 1;
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new AudioPlayerError(AudioPlayerErrorCode.FileTooLarge);
    }

    this.stopPlayback();

    let decodedBuffer: AudioBuffer;
    try {
      decodedBuffer = await this.context.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new AudioPlayerError(AudioPlayerErrorCode.InvalidAudio);
    }

    this.ensureCurrentLoad(loadToken);
    if (decodedBuffer.duration > MAX_DURATION_SECONDS) {
      throw new AudioPlayerError(AudioPlayerErrorCode.DurationTooLong);
    }

    const samples = await this.downmixAndResample(decodedBuffer);
    this.ensureCurrentLoad(loadToken);

    const objectUrl = URL.createObjectURL(file);
    this.element.src = objectUrl;
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.objectUrl = objectUrl;
    // Only the duration is needed — the element plays the file itself, so the
    // decoded AudioBuffer (~200 MB for a long file) is released here.
    this.duration = decodedBuffer.duration;
    this.notifyStateChange();

    return { samples, durationSeconds: decodedBuffer.duration };
  }

  public async play(): Promise<void> {
    if (this.objectUrl === null || this.playing) {
      return;
    }

    const playToken = ++this.playToken;
    if (this.element.currentTime >= this.durationSeconds) {
      this.element.currentTime = 0;
    }

    try {
      await this.element.play();
    } catch {
      return;
    }

    if (playToken !== this.playToken || this.objectUrl === null) {
      this.element.pause();
      return;
    }

    this.playing = true;
    this.notifyStateChange();
  }

  public pause(): void {
    this.playToken += 1;
    if (!this.playing) {
      return;
    }

    this.playing = false;
    this.element.pause();
    this.notifyStateChange();
  }

  public seek(seconds: number): void {
    this.playToken += 1;
    this.element.currentTime = Math.min(
      this.durationSeconds,
      Math.max(0, seconds),
    );
    this.notifyStateChange();
  }

  public setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate)) {
      return;
    }

    const nextRate = Math.min(
      MAX_PLAYBACK_RATE,
      Math.max(MIN_PLAYBACK_RATE, rate),
    );
    this.element.defaultPlaybackRate = nextRate;
    this.element.playbackRate = nextRate;
  }

  public reset(): void {
    this.loadToken += 1;
    this.playToken += 1;
    this.stopPlayback();
    this.duration = 0;
    this.element.removeAttribute('src');
    this.element.load();
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.notifyStateChange();
  }

  private stopPlayback(): void {
    this.playing = false;
    this.element.pause();
    this.element.currentTime = 0;
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

  private ensureCurrentLoad(loadToken: number): void {
    if (loadToken !== this.loadToken) {
      throw new AudioPlayerError(AudioPlayerErrorCode.Cancelled);
    }
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }
}
