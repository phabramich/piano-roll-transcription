import type { AnalysisResult } from './analysis-types';

const FIRST_MIDI_NOTE = 21;
const PITCH_COUNT = 88;
const SAMPLE_RATE = 22050;
const FFT_SIZE = 1024;
const HOP_SIZE = 512;

export async function analyzeFastSpectrum(
  samples: Float32Array,
): Promise<AnalysisResult> {
  if (samples.length === 0) {
    return createEmptyResult();
  }

  const frameCount = Math.max(1, Math.ceil(samples.length / HOP_SIZE));
  const frameProbabilities = new Uint8Array(frameCount * PITCH_COUNT);
  const energies = new Float32Array(frameCount * PITCH_COUNT);
  const frameTimestamps = new Float32Array(frameCount);
  const real = new Float32Array(FFT_SIZE);
  const imaginary = new Float32Array(FFT_SIZE);
  const window = createHannWindow();
  const pitchBinRanges = createPitchBinRanges();
  let maximumEnergy = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * HOP_SIZE;
    real.fill(0);
    imaginary.fill(0);
    for (let sample = 0; sample < FFT_SIZE; sample += 1) {
      real[sample] = (samples[start + sample] ?? 0) * window[sample];
    }
    fft(real, imaginary);
    frameTimestamps[frame] = start / SAMPLE_RATE;

    for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
      const [firstBin, lastBin] = pitchBinRanges[pitch];
      let energy = 0;
      for (let bin = firstBin; bin <= lastBin; bin += 1) {
        energy += real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
      }
      const compressed = Math.log1p(energy);
      maximumEnergy = Math.max(maximumEnergy, compressed);
      energies[frame * PITCH_COUNT + pitch] = compressed;
    }

    if (frame % 32 === 31) {
      await yieldToBrowser();
    }
  }

  normalize(energies, frameProbabilities, maximumEnergy);
  return {
    notes: [],
    frameCount,
    pitchCount: PITCH_COUNT,
    frameProbabilities,
    frameTimestamps,
  };
}

function createEmptyResult(): AnalysisResult {
  return {
    notes: [],
    frameCount: 0,
    pitchCount: PITCH_COUNT,
    frameProbabilities: new Uint8Array(),
    frameTimestamps: new Float32Array(),
  };
}

function createHannWindow(): Float32Array {
  const window = new Float32Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
  }
  return window;
}

function createPitchBinRanges(): Array<[number, number]> {
  return Array.from({ length: PITCH_COUNT }, (_, pitchIndex) => {
    const midi = FIRST_MIDI_NOTE + pitchIndex;
    const center = 440 * 2 ** ((midi - 69) / 12);
    const lower = center * 2 ** (-1 / 24);
    const upper = center * 2 ** (1 / 24);
    const firstBin = Math.max(1, Math.ceil((lower * FFT_SIZE) / SAMPLE_RATE));
    const lastBin = Math.min(
      FFT_SIZE / 2 - 1,
      Math.max(firstBin, Math.floor((upper * FFT_SIZE) / SAMPLE_RATE)),
    );
    return [firstBin, lastBin];
  });
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
    values[index] = Math.round((energies[index] / maximum) * 255);
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}
