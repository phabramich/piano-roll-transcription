const ATTACK_SECONDS = 0.012;
const RELEASE_SECONDS = 0.06;
const PEAK_GAIN = 0.16;

export class PianoAudition {
  private context: AudioContext | null = null;
  private oscillator: OscillatorNode | null = null;
  private gain: GainNode | null = null;

  public prepare(): void {
    const context = this.getContext();
    void context.resume().catch(() => undefined);
  }

  public start(midi: number): void {
    const context = this.getContext();
    this.stop();

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + ATTACK_SECONDS);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      if (this.oscillator === oscillator) {
        this.oscillator = null;
        this.gain = null;
      }
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start();
    this.oscillator = oscillator;
    this.gain = gain;
  }

  public stop(): void {
    const oscillator = this.oscillator;
    const gain = this.gain;
    if (oscillator === null || gain === null || this.context === null) {
      return;
    }

    const now = this.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
    oscillator.stop(now + RELEASE_SECONDS);
    this.oscillator = null;
    this.gain = null;
  }

  private getContext(): AudioContext {
    if (this.context === null) {
      this.context = new AudioContext();
    }
    return this.context;
  }
}
