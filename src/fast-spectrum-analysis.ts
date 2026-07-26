import type { AnalysisResult } from './analysis-types';

const FIRST_MIDI_NOTE = 21;
const PITCH_COUNT = 88;
const SAMPLE_RATE = 22050;
const FFT_SIZE = 8192;
const HOP_SIZE = 2048;
const NORMALIZATION_FLOOR = 0.14;
const NORMALIZATION_GAMMA = 1.8;

export class FastSpectrumAnalyzer {
  public readonly frameCount: number;
  private readonly energies: Float32Array;
  private readonly timestamps: Float32Array;
  private readonly real = new Float32Array(FFT_SIZE);
  private readonly imaginary = new Float32Array(FFT_SIZE);
  private readonly window = createHannWindow();
  private readonly pitchBands = createPitchBands();
  private maximumEnergy = 0;

  public constructor(private readonly samples: Float32Array) {
    this.frameCount = samples.length === 0 ? 0 : Math.ceil(samples.length / HOP_SIZE);
    this.energies = new Float32Array(this.frameCount * PITCH_COUNT);
    this.timestamps = new Float32Array(this.frameCount);
  }

  public frameCountForSeconds(seconds: number): number {
    return Math.min(this.frameCount, Math.ceil((seconds * SAMPLE_RATE) / HOP_SIZE));
  }

  public analyzeFrames(firstFrame: number, endFrame: number): void {
    for (let frame = firstFrame; frame < endFrame; frame += 1) {
      const start = frame * HOP_SIZE;
      this.real.fill(0);
      this.imaginary.fill(0);
      for (let sample = 0; sample < FFT_SIZE; sample += 1) {
        this.real[sample] = (this.samples[start + sample] ?? 0) * this.window[sample];
      }
      fft(this.real, this.imaginary);
      this.timestamps[frame] = start / SAMPLE_RATE;

      for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
        const energy = samplePitchEnergy(this.real, this.imaginary, this.pitchBands[pitch]);
        const compressed = Math.log1p(energy);
        this.maximumEnergy = Math.max(this.maximumEnergy, compressed);
        this.energies[frame * PITCH_COUNT + pitch] = compressed;
      }
    }
  }

  public toResult(frameCount: number): AnalysisResult {
    const safeFrameCount = Math.max(0, Math.min(this.frameCount, frameCount));
    const frameProbabilities = new Uint8Array(safeFrameCount * PITCH_COUNT);
    normalize(
      this.energies.subarray(0, frameProbabilities.length),
      frameProbabilities,
      this.maximumEnergy,
    );
    return {
      notes: [],
      frameCount: safeFrameCount,
      pitchCount: PITCH_COUNT,
      frameProbabilities,
      frameTimestamps: this.timestamps.slice(0, safeFrameCount),
    };
  }
}

interface PitchBand {
  centerBin: number;
  firstBin: number;
  lastBin: number;
}

function createHannWindow(): Float32Array {
  const window = new Float32Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
  }
  return window;
}

function createPitchBands(): PitchBand[] {
  return Array.from({ length: PITCH_COUNT }, (_, pitchIndex) => {
    const midi = FIRST_MIDI_NOTE + pitchIndex;
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const lowerFrequency = frequency * 2 ** (-1 / 24);
    const upperFrequency = frequency * 2 ** (1 / 24);
    return {
      centerBin: (frequency * FFT_SIZE) / SAMPLE_RATE,
      firstBin: Math.max(1, Math.ceil((lowerFrequency * FFT_SIZE) / SAMPLE_RATE)),
      lastBin: Math.min(
        FFT_SIZE / 2 - 1,
        Math.floor((upperFrequency * FFT_SIZE) / SAMPLE_RATE),
      ),
    };
  });
}

function samplePitchEnergy(
  real: Float32Array,
  imaginary: Float32Array,
  band: PitchBand,
): number {
  if (band.firstBin > band.lastBin) {
    return interpolateBinEnergy(real, imaginary, band.centerBin);
  }

  let energy = 0;
  for (let bin = band.firstBin; bin <= band.lastBin; bin += 1) {
    energy += binEnergy(real, imaginary, bin);
  }
  return energy / (band.lastBin - band.firstBin + 1);
}

function interpolateBinEnergy(
  real: Float32Array,
  imaginary: Float32Array,
  position: number,
): number {
  const lower = Math.max(1, Math.min(FFT_SIZE / 2 - 1, Math.floor(position)));
  const upper = Math.min(FFT_SIZE / 2 - 1, lower + 1);
  const fraction = position - Math.floor(position);
  return (
    binEnergy(real, imaginary, lower) * (1 - fraction) +
    binEnergy(real, imaginary, upper) * fraction
  );
}

function binEnergy(real: Float32Array, imaginary: Float32Array, bin: number): number {
  return real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
}

function fft(real: Float32Array, imaginary: Float32Array): void {
  let reverse = 0;
  for (let index = 1; index < FFT_SIZE; index += 1) {
    let bit = FFT_SIZE >> 1;
    while ((reverse & bit) !== 0) {
      reverse ^= bit;
      bit >>= 1;
    }
    reverse ^= bit;
    if (index < reverse) {
      [real[index], real[reverse]] = [real[reverse], real[index]];
      [imaginary[index], imaginary[reverse]] = [imaginary[reverse], imaginary[index]];
    }
  }

  for (let length = 2; length <= FFT_SIZE; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < FFT_SIZE; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      const half = length >> 1;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

function normalize(
  energies: Float32Array,
  values: Uint8Array,
  maximum: number,
): void {
  if (maximum <= 0) {
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    const normalized = energies[index] / maximum;
    const contrasted = Math.max(
      0,
      (normalized - NORMALIZATION_FLOOR) / (1 - NORMALIZATION_FLOOR),
    ) ** NORMALIZATION_GAMMA;
    values[index] = Math.round(contrasted * 255);
  }
}
