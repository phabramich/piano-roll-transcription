import type { AnalysisResult, AnalyzedNote } from './analysis-types';

const FIRST_MIDI_NOTE = 21;
const PITCH_COUNT = 88;
const SAMPLE_RATE = 22050;
const FFT_SIZE = 8192;
const HOP_SIZE = 2048;
const BIN_COUNT = FFT_SIZE / 2 + 1;
const NORMALIZATION_FLOOR = 0.07;
const NORMALIZATION_GAMMA = 1.4;
const HARMONIC_TIME_RADIUS = 2;
const PERCUSSIVE_PITCH_RADIUS = 4;
const MASK_EXPONENT = 1.35;
const FRAME_FLOOR_PERCENTILE = 0.42;
const MASK_EPSILON = 1e-6;

// Whitened spectrum: broadband noise sits near 1, true partials stand out as ratios.
const WHITEN_FLOOR_RATIO = 1e-4;
const PEAK_MIN_RATIO = 1.5;
const NOISE_FLOOR = 1;

// Candidates are scored on a ±50-cent grid so detuned pianos and the Railsback
// stretch still line up their partials.
const DETUNE_STEPS_CENTS = [-50, -25, 0, 25, 50];
const DETUNE_STEP_COUNT = DETUNE_STEPS_CENTS.length;

// Fletcher/Young piano inharmonicity: partial n sits at n·f0·sqrt(1 + B·n²).
// B rises toward the treble (~doubles every 8 semitones above middle C).
const INHARMONICITY_BASE = 3.5e-4;
const INHARMONICITY_REF_MIDI = 60;
const INHARMONICITY_OCTAVE_RATE = 8;
// Wound bass strings still carry some stretch the treble model under-estimates.
const INHARMONICITY_FLOOR = 2e-4;
const MAX_PARTIALS = 14;
const MAX_PARTIAL_FREQUENCY = 10500;
const PARTIAL_WEIGHT_EXPONENT = 0.9;
const PARTIAL_SNAP_RADIUS_BINS = 1.5;
const PARTIAL_FALLBACK_WEIGHT = 0.4;
const MIN_PARTIAL_COUNT = 3;
// Missing partials actively cost salience (down to this cap) — that's what
// stops candidates that only coincide with other notes' harmonics.
const MISSING_PARTIAL_CAP = 0.5;
// One partial can only contribute this much: a real note wins on many medium
// partials, a ghost can't ride on two or three giant coincidences.
const PARTIAL_SATURATION = 2;

// Iterative estimate-and-cancel (Klapuri): pick the strongest note, remove its
// partials from the residual, repeat. Kills octave/fifth ghosts.
const MAX_NOTES_PER_FRAME = 8;
const CANCEL_FOOTPRINT_BINS = 2.5;
const STOP_RATIO = 0.15;
const STOP_ABSOLUTE = 1.0;
const SHORTLIST_COUNT = 16;
const SHORTLIST_RATIO = 0.2;

// Post-pick fundamental refinement: measured snapped partials are refit to the
// inharmonic model and the winner is clamped inside ±75 cents of the grid f0.
const REFINEMENT_MIN_PARTIALS = 3;
const REFINEMENT_MIN_PARTIALS_FOR_B = 5;
const REFINEMENT_MAX_DETUNE = 2 ** (75 / 1200);
const REFINEMENT_B_CANDIDATES = [0.25, 1, 4];

// First-order temporal prior (cheap HMM): a pitch detected recently gets a
// score boost that decays over ~300 ms. Sustained/decaying notes stop
// flickering at the threshold; a note absent for ~30 frames gets no help.
const PERSISTENCE_GAIN = 0.6;
const PERSISTENCE_DECAY = 0.96;

// Onset detection: broadband spectral flux catches attacks from silence, but
// whitened decay keeps ringing partials flat — a re-strike shows no energy
// dip. Weighted phase deviation catches what flux can't: steady partials
// advance phase predictably, a new attack decorrelates it. Both cues feed
// the onset function; peak-picked against a running median.
const ONSET_MEDIAN_RATIO = 3;
const ONSET_ABSOLUTE = 6;
const ONSET_REFRACTORY_FRAMES = 3;
const TAU = 2 * Math.PI;
// Phase deviation is a 0..π fraction; scale it into the flux range so one
// threshold governs both cues.
const FLUX_PHASE_SCALE = 30;

// Note segmentation on the enhanced pitch tracks: hysteresis enter/exit
// thresholds relative to the file peak, plus a minimum duration. A segment
// whose *mean* intensity stays faint is a ghost track, not a played note.
const NOTE_ON_RATIO = 0.3;
const NOTE_OFF_RATIO = 0.18;
const NOTE_MIN_FRAMES = 2;
const NOTE_MIN_MEAN_RATIO = 0.35;
const NOTE_ONSET_DIP = 0.6;
const NOTE_ONSET_RISE = 1.15;
const NOTE_ONSET_LOOKBACK = 4;

interface PartialLayout {
  // For every pitch and detune step: bin positions of the stretched partials.
  positions: Float32Array;
  // Per pitch: how many partials fit below MAX_PARTIAL_FREQUENCY.
  counts: Uint8Array;
  weights: Float32Array;
  // Equal-tempered fundamentals (Hz) and the Fletcher B prior per pitch.
  fundamentals: Float32Array;
  inharmonicity: Float32Array;
}

const PARTIAL_LAYOUT = createPartialLayout();

export class FastSpectrumAnalyzer {
  public readonly frameCount: number;
  private readonly energies: Float32Array;
  private readonly timestamps: Float32Array;
  private readonly real = new Float32Array(FFT_SIZE);
  private readonly imaginary = new Float32Array(FFT_SIZE);
  private readonly window = createBlackmanHarrisWindow();
  private readonly magnitude = new Float32Array(BIN_COUNT);
  private readonly whitened = new Float32Array(BIN_COUNT);
  private readonly residual = new Float32Array(BIN_COUNT);
  private readonly envelope = new Float32Array(BIN_COUNT);
  private readonly prefix = new Float32Array(BIN_COUNT + 1);
  private readonly snapPosition = new Float32Array(BIN_COUNT);
  private readonly phase = new Float32Array(BIN_COUNT);
  private readonly previousPhase = new Float32Array(BIN_COUNT);
  private readonly candidateScores = new Float32Array(PITCH_COUNT);
  private readonly candidateSteps = new Int8Array(PITCH_COUNT);
  private readonly shortlist = new Int32Array(PITCH_COUNT);
  private readonly used = new Uint8Array(PITCH_COUNT);
  private readonly refinedPositions = new Float32Array(MAX_PARTIALS);
  private readonly partialWeights = new Float32Array(MAX_PARTIALS);
  private readonly partialBins = new Float32Array(MAX_PARTIALS);
  private readonly partialHarmonics = new Uint8Array(MAX_PARTIALS);
  private readonly verifyResidual = new Float32Array(BIN_COUNT);
  private readonly acceptedPitches = new Uint8Array(MAX_NOTES_PER_FRAME);
  private readonly acceptedSteps = new Int8Array(MAX_NOTES_PER_FRAME);
  private readonly acceptedScores = new Float32Array(MAX_NOTES_PER_FRAME);
  private readonly acceptedPositions = new Float32Array(
    MAX_NOTES_PER_FRAME * MAX_PARTIALS,
  );
  // Per-pitch continuity state: how recently/how strongly each note sounded.
  private readonly persistence = new Float32Array(PITCH_COUNT);
  private readonly prevWhitened = new Float32Array(BIN_COUNT);
  private readonly previousPhase2 = new Float32Array(BIN_COUNT);
  private readonly onsetFlux: Float32Array;
  // Raw magnitude at each pitch's fundamental slot per frame — the whitened
  // tracks can't see decay (ratios persist), but re-strike segmentation
  // needs a dip signal, and real magnitude decays.
  private readonly fundamentalAmp: Float32Array;
  private hasPreviousPhase = false;
  private hasPrevWhitened = false;

  public constructor(private readonly samples: Float32Array) {
    this.frameCount = samples.length === 0 ? 0 : Math.ceil(samples.length / HOP_SIZE);
    this.energies = new Float32Array(this.frameCount * PITCH_COUNT);
    this.timestamps = new Float32Array(this.frameCount);
    this.onsetFlux = new Float32Array(this.frameCount);
    this.fundamentalAmp = new Float32Array(this.frameCount * PITCH_COUNT);
  }

  public frameCountForSeconds(seconds: number): number {
    return Math.min(this.frameCount, Math.ceil((seconds * SAMPLE_RATE) / HOP_SIZE));
  }

  public analyzeFrames(firstFrame: number, endFrame: number): void {
    for (let frame = firstFrame; frame < endFrame; frame += 1) {
      const start = frame * HOP_SIZE;
      for (let sample = 0; sample < FFT_SIZE; sample += 1) {
        this.real[sample] = (this.samples[start + sample] ?? 0) * this.window[sample];
        this.imaginary[sample] = 0;
      }
      fft(this.real, this.imaginary);
      this.timestamps[frame] = start / SAMPLE_RATE;
      this.analyzeSpectrum(frame);
    }
  }

  public toResult(frameCount: number): AnalysisResult {
    const safeFrameCount = Math.max(0, Math.min(this.frameCount, frameCount));
    const source = this.energies.subarray(0, safeFrameCount * PITCH_COUNT);
    const enhanced = enhancePitchedEnergy(source, safeFrameCount);
    const frameProbabilities = new Uint8Array(enhanced.length);
    const peak = maxValue(enhanced);
    normalize(enhanced, frameProbabilities, peak);
    // Segment on the raw energies, not the enhanced display track — the HPSS
    // smoothing and persistence prior fill exactly the dips that separate
    // repeated strikes of the same key.
    return {
      notes: this.segmentNotes(
        source,
        this.fundamentalAmp.subarray(0, safeFrameCount * PITCH_COUNT),
        maxValue(source),
        safeFrameCount,
      ),
      frameCount: safeFrameCount,
      pitchCount: PITCH_COUNT,
      frameProbabilities,
      frameTimestamps: this.timestamps.slice(0, safeFrameCount),
    };
  }

  /**
   * Segment each pitch track into note events: hysteresis on/off thresholds,
   * split a sustained run when a global onset fires through a dip (repeated
   * strikes of the same key). Amplitude is the segment peak relative to the
   * file peak — same scale the renderer colors.
   */
  private segmentNotes(
    track: Float32Array,
    amps: Float32Array,
    peak: number,
    frameCount: number,
  ): AnalyzedNote[] {
    const onsets = pickOnsets(this.onsetFlux, frameCount);
    const notes: AnalyzedNote[] = [];
    const onThreshold = peak * NOTE_ON_RATIO;
    const offThreshold = peak * NOTE_OFF_RATIO;

    for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
      let runStart = -1;
      let segmentStart = -1;
      let segmentPeak = 0;
      let segmentSum = 0;
      let ampPeak = 0;

      const close = (endFrame: number) => {
        const length = endFrame - segmentStart;
        if (
          segmentStart >= 0 &&
          length >= NOTE_MIN_FRAMES &&
          segmentSum / length > peak * NOTE_MIN_MEAN_RATIO
        ) {
          notes.push({
            pitchMidi: FIRST_MIDI_NOTE + pitch,
            amplitude: Math.min(1, segmentPeak / peak),
            startFrame: segmentStart,
            endFrame,
            startTimeSeconds: this.timestamps[segmentStart],
            endTimeSeconds: this.timestamps[endFrame - 1],
          });
        }
      };

      for (let frame = 0; frame <= frameCount; frame += 1) {
        const value = frame < frameCount ? track[frame * PITCH_COUNT + pitch] : 0;
        const amp = frame < frameCount ? amps[frame * PITCH_COUNT + pitch] : 0;
        const active = runStart >= 0 ? value > offThreshold : value > onThreshold;
        if (active) {
          if (runStart < 0) {
            runStart = frame;
            segmentStart = frame;
            segmentPeak = value;
            segmentSum = 0;
            ampPeak = 0;
          } else {
            segmentPeak = Math.max(segmentPeak, value);
          }
          segmentSum += value;
          ampPeak = Math.max(ampPeak, amp);
          // A global onset whose preceding frames dipped deep inside a
          // sustained run means the key was struck again. The dip is read on
          // the raw fundamental magnitude — the whitened score track can't
          // see decay, real amplitude can.
          if (frame > segmentStart && onsets[frame] === 1 && ampPeak > 0) {
            let dip = amp;
            const first = Math.max(segmentStart, frame - NOTE_ONSET_LOOKBACK);
            for (let back = frame - 1; back >= first; back -= 1) {
              dip = Math.min(dip, amps[back * PITCH_COUNT + pitch]);
            }
            if (dip < ampPeak * NOTE_ONSET_DIP && amp > dip * NOTE_ONSET_RISE) {
              close(frame);
              segmentStart = frame;
              segmentPeak = value;
              segmentSum = value;
              ampPeak = amp;
            }
          }
        } else if (runStart >= 0) {
          close(frame);
          runStart = -1;
          segmentStart = -1;
          segmentPeak = 0;
          segmentSum = 0;
          ampPeak = 0;
        }
      }
    }
    notes.sort((a, b) => a.startFrame - b.startFrame || a.pitchMidi - b.pitchMidi);
    return notes;
  }

  private analyzeSpectrum(frame: number): void {
    const { magnitude, whitened, residual, phase, previousPhase } = this;
    let maximum = 0;
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      const re = this.real[bin];
      const im = this.imaginary[bin];
      magnitude[bin] = Math.sqrt(re * re + im * im);
      phase[bin] = Math.atan2(im, re);
      if (magnitude[bin] > maximum) {
        maximum = magnitude[bin];
      }
    }

    whitenSpectrum(magnitude, whitened, this.envelope, this.prefix, maximum);

    // Broadband spectral flux + weighted phase deviation: the first catches
    // attacks from silence, the second catches re-strikes over ringing tails
    // (steady partials advance phase predictably; new energy decorrelates).
    let flux = 0;
    if (this.hasPrevWhitened) {
      for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        flux += Math.max(0, whitened[bin] - this.prevWhitened[bin]);
      }
    }
    if (frame >= 2) {
      let phaseDeviation = 0;
      let weightSum = 0;
      for (let bin = 1; bin < BIN_COUNT; bin += 1) {
        const deviation =
          phase[bin] - 2 * previousPhase[bin] + this.previousPhase2[bin];
        const wrapped = Math.abs(deviation - Math.round(deviation / TAU) * TAU);
        const weight = magnitude[bin];
        phaseDeviation += weight * wrapped;
        weightSum += weight;
      }
      if (weightSum > 0) {
        flux += (phaseDeviation / weightSum) * FLUX_PHASE_SCALE;
      }
    }
    this.onsetFlux[frame] = flux;
    this.prevWhitened.set(whitened);
    this.hasPrevWhitened = true;

    // Fundamental-slot magnitude per pitch — the decay-visible dip signal
    // used for re-strike splitting in segmentNotes().
    {
      const base = frame * PITCH_COUNT;
      const positions = PARTIAL_LAYOUT.positions;
      for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
        const f1 = positions[(pitch * DETUNE_STEP_COUNT + 2) * MAX_PARTIALS];
        this.fundamentalAmp[base + pitch] = interpolate(magnitude, f1);
      }
    }

    buildSnapMap(whitened, phase, previousPhase, this.hasPreviousPhase, this.snapPosition);
    this.previousPhase2.set(previousPhase);
    this.previousPhase.set(phase);
    this.hasPreviousPhase = true;
    residual.set(whitened);

    const frameOffset = frame * PITCH_COUNT;
    this.energies.fill(0, frameOffset, frameOffset + PITCH_COUNT);
    const used = this.used.fill(0);
    const { acceptedPitches, acceptedSteps, acceptedScores, acceptedPositions } = this;
    let firstScore = 0;
    let accepted = 0;

    for (let iteration = 0; iteration < MAX_NOTES_PER_FRAME; iteration += 1) {
      const best = this.scoreCandidates(used);
      if (
        best.pitch < 0 ||
        best.score < Math.max(firstScore * STOP_RATIO, STOP_ABSOLUTE)
      ) {
        break;
      }
      if (iteration === 0) {
        firstScore = best.score;
      }
      used[best.pitch] = 1;
      const positions = this.refinePositions(best.pitch, best.step);
      acceptedPitches[accepted] = best.pitch;
      acceptedSteps[accepted] = best.step;
      acceptedScores[accepted] = best.score;
      acceptedPositions.set(positions.subarray(0, PARTIAL_LAYOUT.counts[best.pitch]), accepted * MAX_PARTIALS);
      this.energies[frameOffset + best.pitch] = Math.max(
        this.energies[frameOffset + best.pitch],
        Math.log1p(best.score * 4),
      );
      this.cancelNote(best.pitch, positions, residual);
      accepted += 1;
    }

    if (accepted > 1) {
      this.verifyAccepted(accepted, frameOffset);
    }

    // Temporal prior update: decay all pitches, then mark the ones that
    // sounded this frame — proportional to their relative strength, so a
    // marginal detection can't fully re-boost itself next frame.
    const { persistence } = this;
    for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
      persistence[pitch] *= PERSISTENCE_DECAY;
    }
    for (let index = 0; index < accepted; index += 1) {
      const strength = Math.min(1, acceptedScores[index] / firstScore);
      const pitch = acceptedPitches[index];
      persistence[pitch] = Math.max(persistence[pitch], strength);
    }
  }

  /**
   * Independence check: rebuild a residual with every *other* accepted note's
   * footprint removed and re-score each candidate on it. A ghost whose
   * partials were entirely explained by stronger relatives loses its evidence
   * and its energy collapses; a real note keeps its own f1/f2 slots.
   */
  private verifyAccepted(accepted: number, frameOffset: number): void {
    const { whitened, verifyResidual, acceptedPitches, acceptedSteps, acceptedPositions } = this;
    for (let index = 0; index < accepted; index += 1) {
      verifyResidual.set(whitened);
      for (let other = 0; other < accepted; other += 1) {
        if (other !== index) {
          this.cancelNote(
            acceptedPitches[other],
            acceptedPositions.subarray(other * MAX_PARTIALS, other * MAX_PARTIALS + MAX_PARTIALS),
            verifyResidual,
          );
        }
      }
      const verified = this.salience(
        acceptedPitches[index],
        acceptedSteps[index],
        PARTIAL_LAYOUT,
        verifyResidual,
      );
      const slot = frameOffset + acceptedPitches[index];
      this.energies[slot] = Math.min(this.energies[slot], Math.log1p(Math.max(0, verified) * 4));
    }
  }

  /**
   * Fit the winner's true fundamental (and inharmonicity, when enough partials
   * were measured) from the snapped peak positions. The ±50¢ grid gets within
   * a quarter-tone; the LSQ fit gets within a few cents — the cancellation
   * footprint then lands on the note's actual energy instead of its neighbors'.
   */
  private refinePositions(pitch: number, step: number): Float32Array {
    const layout = PARTIAL_LAYOUT;
    const count = layout.counts[pitch];
    const base = (pitch * DETUNE_STEP_COUNT + step) * MAX_PARTIALS;
    const { residual, snapPosition, refinedPositions, partialWeights, partialBins, partialHarmonics } = this;
    const modelB = layout.inharmonicity[pitch];

    let measured = 0;
    for (let n = 0; n < count; n += 1) {
      const position = layout.positions[base + n];
      const bin = Math.min(BIN_COUNT - 1, Math.max(0, Math.round(position)));
      const snap = snapPosition[bin];
      if (snap < 0 || Math.abs(snap - position) > PARTIAL_SNAP_RADIUS_BINS) {
        continue;
      }
      partialWeights[measured] = Math.min(
        interpolate(residual, snap),
        PARTIAL_SATURATION + 1,
      );
      partialBins[measured] = snap;
      partialHarmonics[measured] = n + 1;
      measured += 1;
    }

    const centerFrequency = layout.fundamentals[pitch] * 2 ** (DETUNE_STEPS_CENTS[step] / 1200);
    let fundamental = centerFrequency;
    let inharmonicity = modelB;
    if (measured >= REFINEMENT_MIN_PARTIALS) {
      const fit = fitInharmonicModel(
        partialBins,
        partialHarmonics,
        partialWeights,
        measured,
        modelB,
      );
      if (fit.fundamental > 0) {
        fundamental = clamp(
          fit.fundamental,
          centerFrequency * REFINEMENT_MAX_DETUNE,
          centerFrequency / REFINEMENT_MAX_DETUNE,
        );
        inharmonicity = fit.inharmonicity;
      }
    }

    for (let n = 0; n < count; n += 1) {
      const harmonic = n + 1;
      const frequency =
        fundamental * harmonic * Math.sqrt(1 + inharmonicity * harmonic * harmonic);
      refinedPositions[n] = (frequency * FFT_SIZE) / SAMPLE_RATE;
    }
    return refinedPositions;
  }

  private scoreCandidates(used: Uint8Array): {
    pitch: number;
    step: number;
    score: number;
  } {
    const { candidateScores, candidateSteps, shortlist } = this;
    const layout = PARTIAL_LAYOUT;

    // Pass 1: coarse score at center detune for all pitches.
    let bestCoarse = 0;
    for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
      const score = used[pitch] !== 0
        ? 0
        : this.salience(pitch, 2, layout, this.residual) *
          (1 + PERSISTENCE_GAIN * this.persistence[pitch]);
      candidateScores[pitch] = score;
      candidateSteps[pitch] = 2;
      if (score > bestCoarse) {
        bestCoarse = score;
      }
    }
    if (bestCoarse <= 0) {
      return { pitch: -1, step: 0, score: 0 };
    }

    // Pass 2: full detune grid only for the strongest candidates.
    let shortlistCount = 0;
    const threshold = bestCoarse * SHORTLIST_RATIO;
    for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
      if (candidateScores[pitch] >= threshold && shortlistCount < SHORTLIST_COUNT) {
        shortlist[shortlistCount] = pitch;
        shortlistCount += 1;
      }
    }

    let bestPitch = -1;
    let bestStep = 0;
    let bestScore = 0;
    for (let index = 0; index < shortlistCount; index += 1) {
      const pitch = shortlist[index];
      for (let step = 0; step < DETUNE_STEP_COUNT; step += 1) {
        if (step === 2) {
          continue;
        }
        const score =
          this.salience(pitch, step, layout, this.residual) *
          (1 + PERSISTENCE_GAIN * this.persistence[pitch]);
        if (score > candidateScores[pitch]) {
          candidateScores[pitch] = score;
          candidateSteps[pitch] = step;
        }
      }
      if (candidateScores[pitch] > bestScore) {
        bestScore = candidateScores[pitch];
        bestPitch = pitch;
        bestStep = candidateSteps[pitch];
      }
    }
    return { pitch: bestPitch, step: bestStep, score: bestScore };
  }

  private salience(
    pitch: number,
    step: number,
    layout: PartialLayout,
    spectrum: Float32Array,
  ): number {
    const count = layout.counts[pitch];
    if (count === 0) {
      return 0;
    }
    const base = (pitch * DETUNE_STEP_COUNT + step) * MAX_PARTIALS;
    const { snapPosition } = this;
    let sum = 0;
    for (let n = 0; n < count; n += 1) {
      const weight = layout.weights[n];
      const position = layout.positions[base + n];
      const bin = Math.min(BIN_COUNT - 1, Math.max(0, Math.round(position)));
      const snap = snapPosition[bin];
      const amplitude = snap >= 0
        ? interpolate(spectrum, snap)
        : interpolate(spectrum, position) * PARTIAL_FALLBACK_WEIGHT;
      const excess = amplitude - NOISE_FLOOR;
      // A missing fundamental costs its whole weight — a note whose f1 slot is
      // empty is usually a harmonic of something else, not a played key.
      const penalty = n === 0 ? 1 : MISSING_PARTIAL_CAP;
      sum += weight * Math.max(Math.min(excess, PARTIAL_SATURATION), -penalty);
    }
    return sum;
  }

  private cancelNote(
    pitch: number,
    positions: Float32Array,
    spectrum: Float32Array,
  ): void {
    const count = PARTIAL_LAYOUT.counts[pitch];
    const { snapPosition } = this;

    for (let n = 0; n < count; n += 1) {
      const position = positions[n];
      const bin = Math.min(BIN_COUNT - 1, Math.max(0, Math.round(position)));
      const center = snapPosition[bin] >= 0 ? snapPosition[bin] : position;
      const amplitude = interpolate(spectrum, center);
      const first = Math.max(0, Math.floor(center - CANCEL_FOOTPRINT_BINS));
      const last = Math.min(BIN_COUNT - 1, Math.ceil(center + CANCEL_FOOTPRINT_BINS));
      for (let k = first; k <= last; k += 1) {
        const shape = 1 - Math.abs(k - center) / CANCEL_FOOTPRINT_BINS;
        spectrum[k] = Math.max(NOISE_FLOOR, spectrum[k] - amplitude * shape);
      }
    }
  }
}

/**
 * Peak-pick the spectral-flux onset function: local maxima above
 * max(median·ratio, absolute floor), with a short refractory so one attack
 * can't fire twice. Returns a per-frame 0/1 mask.
 */
function pickOnsets(flux: Float32Array, frameCount: number): Uint8Array {
  const onsets = new Uint8Array(frameCount);
  if (frameCount === 0) {
    return onsets;
  }
  const sorted = Array.from(flux.subarray(0, frameCount)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(median * ONSET_MEDIAN_RATIO, ONSET_ABSOLUTE);

  let lastOnset = -ONSET_REFRACTORY_FRAMES - 1;
  for (let frame = 1; frame < frameCount - 1; frame += 1) {
    const value = flux[frame];
    if (
      value > threshold &&
      value >= flux[frame - 1] &&
      value >= flux[frame + 1] &&
      frame - lastOnset > ONSET_REFRACTORY_FRAMES
    ) {
      onsets[frame] = 1;
      lastOnset = frame;
    }
  }
  return onsets;
}

function createBlackmanHarrisWindow(): Float32Array {
  // 4-term Blackman-Harris: −92 dB sidelobes, ~4-bin main lobe.
  const window = new Float32Array(FFT_SIZE);
  const a0 = 0.35875;
  const a1 = 0.48829;
  const a2 = 0.14128;
  const a3 = 0.01168;
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const phase = (2 * Math.PI * index) / (FFT_SIZE - 1);
    window[index] =
      a0 - a1 * Math.cos(phase) + a2 * Math.cos(2 * phase) - a3 * Math.cos(3 * phase);
  }
  return window;
}

function createPartialLayout(): PartialLayout {
  const positions = new Float32Array(
    PITCH_COUNT * DETUNE_STEP_COUNT * MAX_PARTIALS,
  );
  const counts = new Uint8Array(PITCH_COUNT);
  const weights = new Float32Array(MAX_PARTIALS);
  const fundamentals = new Float32Array(PITCH_COUNT);
  const inharmonicityProfile = new Float32Array(PITCH_COUNT);
  for (let n = 0; n < MAX_PARTIALS; n += 1) {
    weights[n] = (n + 1) ** -PARTIAL_WEIGHT_EXPONENT;
  }

  for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
    const midi = FIRST_MIDI_NOTE + pitch;
    const fundamental = 440 * 2 ** ((midi - 69) / 12);
    const inharmonicity = Math.max(
      INHARMONICITY_BASE *
        2 ** ((midi - INHARMONICITY_REF_MIDI) / INHARMONICITY_OCTAVE_RATE),
      INHARMONICITY_FLOOR,
    );
    fundamentals[pitch] = fundamental;
    inharmonicityProfile[pitch] = inharmonicity;

    let count = 0;
    for (let step = 0; step < DETUNE_STEP_COUNT; step += 1) {
      const detuned = fundamental * 2 ** (DETUNE_STEPS_CENTS[step] / 1200);
      const base = (pitch * DETUNE_STEP_COUNT + step) * MAX_PARTIALS;
      for (let n = 0; n < MAX_PARTIALS; n += 1) {
        const harmonic = n + 1;
        const frequency =
          detuned * harmonic * Math.sqrt(1 + inharmonicity * harmonic * harmonic);
        positions[base + n] = (frequency * FFT_SIZE) / SAMPLE_RATE;
        if (step === 2 && frequency <= MAX_PARTIAL_FREQUENCY) {
          count = harmonic;
        }
      }
    }
    counts[pitch] = count >= MIN_PARTIAL_COUNT ? count : 0;
  }
  return {
    positions,
    counts,
    weights,
    fundamentals,
    inharmonicity: inharmonicityProfile,
  };
}

/**
 * Weighted least-squares fit of the inharmonic model f_n = n·f1·√(1+B·n²) to
 * measured partial positions. f1 falls out as a weighted mean of per-partial
 * estimates; B is picked from a small multiplicative grid around the Fletcher
 * prior (only with enough partials to constrain it — otherwise the prior wins).
 */
function fitInharmonicModel(
  bins: Float32Array,
  harmonics: Uint8Array,
  weights: Float32Array,
  measured: number,
  modelB: number,
): { fundamental: number; inharmonicity: number } {
  const candidates =
    measured >= REFINEMENT_MIN_PARTIALS_FOR_B
      ? REFINEMENT_B_CANDIDATES
      : [1];
  const binToHz = SAMPLE_RATE / FFT_SIZE;
  let bestError = Infinity;
  let bestFundamental = 0;
  let bestB = modelB;

  for (const factor of candidates) {
    const b = modelB * factor;
    let weightSum = 0;
    let estimateSum = 0;
    for (let index = 0; index < measured; index += 1) {
      const harmonic = harmonics[index];
      const estimate =
        (bins[index] * binToHz) /
        (harmonic * Math.sqrt(1 + b * harmonic * harmonic));
      const weight = weights[index];
      estimateSum += weight * estimate;
      weightSum += weight;
    }
    if (weightSum <= 0) {
      continue;
    }
    const fundamental = estimateSum / weightSum;

    let error = 0;
    for (let index = 0; index < measured; index += 1) {
      const harmonic = harmonics[index];
      const predicted =
        (fundamental * harmonic * Math.sqrt(1 + b * harmonic * harmonic)) / binToHz;
      const deviation = predicted - bins[index];
      error += weights[index] * deviation * deviation;
    }
    if (error < bestError) {
      bestError = error;
      bestFundamental = fundamental;
      bestB = b;
    }
  }

  return { fundamental: bestFundamental, inharmonicity: bestB };
}

/**
 * Whitening: divide the magnitude spectrum by a local moving-average envelope
 * (~quarter-octave wide). Broadband noise maps to ≈1, resolved partials
 * to ratios above it — this normalizes bright vs. dull instruments so the
 * harmonic vote isn't dominated by spectral envelope shape.
 */
function whitenSpectrum(
  magnitude: Float32Array,
  whitened: Float32Array,
  envelope: Float32Array,
  prefix: Float32Array,
  maximum: number,
): void {
  const floor = Math.max(maximum * WHITEN_FLOOR_RATIO, 1e-12);
  prefix[0] = 0;
  for (let bin = 0; bin < BIN_COUNT; bin += 1) {
    prefix[bin + 1] = prefix[bin] + magnitude[bin];
  }
  for (let bin = 0; bin < BIN_COUNT; bin += 1) {
    const halfWidth = Math.max(8, bin >> 2);
    const left = Math.max(0, bin - halfWidth);
    const right = Math.min(BIN_COUNT - 1, bin + halfWidth);
    envelope[bin] = Math.max(
      (prefix[right + 1] - prefix[left]) / (right - left + 1),
      floor,
    );
    whitened[bin] = magnitude[bin] / envelope[bin];
  }
}

/**
 * Peak detection + sub-bin refinement. Each local maximum gets a refined
 * position: the phase-vocoder instantaneous frequency (phase advance between
 * consecutive frames at the same bin) is preferred since it stays unbiased
 * when a neighbour pulls the peak asymmetric; parabolic interpolation on the
 * magnitude is the fallback and the sanity bound.
 */
function buildSnapMap(
  whitened: Float32Array,
  phase: Float32Array,
  previousPhase: Float32Array,
  hasPreviousPhase: boolean,
  snapPosition: Float32Array,
): void {
  snapPosition.fill(-1);
  const binsPerRadian = FFT_SIZE / (2 * Math.PI * HOP_SIZE);

  for (let bin = 2; bin < BIN_COUNT - 2; bin += 1) {
    const center = whitened[bin];
    if (
      center < PEAK_MIN_RATIO ||
      center <= whitened[bin - 1] ||
      center <= whitened[bin + 1] ||
      center <= whitened[bin - 2] ||
      center <= whitened[bin + 2]
    ) {
      continue;
    }

    const denominator = whitened[bin - 1] - 2 * center + whitened[bin + 1];
    let refined = bin;
    if (denominator !== 0) {
      const delta = 0.5 * (whitened[bin - 1] - whitened[bin + 1]) / denominator;
      refined = bin + Math.max(-0.5, Math.min(0.5, delta));
    }

    if (hasPreviousPhase) {
      const expected = (2 * Math.PI * bin * HOP_SIZE) / FFT_SIZE;
      let advance = phase[bin] - previousPhase[bin] - expected;
      advance -= Math.round(advance / (2 * Math.PI)) * 2 * Math.PI;
      const instantaneous = bin + advance * binsPerRadian;
      if (Math.abs(instantaneous - bin) <= 1.5) {
        refined = instantaneous;
      }
    }

    const first = Math.max(0, Math.floor(refined - PARTIAL_SNAP_RADIUS_BINS));
    const last = Math.min(BIN_COUNT - 1, Math.ceil(refined + PARTIAL_SNAP_RADIUS_BINS));
    for (let k = first; k <= last; k += 1) {
      const existing = snapPosition[k];
      if (existing < 0 || Math.abs(refined - k) < Math.abs(existing - k)) {
        snapPosition[k] = refined;
      }
    }
  }
}

function interpolate(values: Float32Array, position: number): number {
  const clamped = Math.min(BIN_COUNT - 1, Math.max(0, position));
  const lower = Math.floor(clamped);
  const upper = Math.min(BIN_COUNT - 1, lower + 1);
  const fraction = clamped - lower;
  return values[lower] * (1 - fraction) + values[upper] * fraction;
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

/**
 * Soft HPSS on the pitchogram:
 * sustained pitched energy (bass, melody) survives the harmonic median;
 * broadband drum hits dominate the percussive median and get masked down.
 */
function enhancePitchedEnergy(
  energies: Float32Array,
  frameCount: number,
): Float32Array {
  if (frameCount === 0) {
    return new Float32Array(0);
  }

  const harmonic = new Float32Array(energies.length);
  const percussive = new Float32Array(energies.length);
  const timeScratch = new Float32Array(HARMONIC_TIME_RADIUS * 2 + 1);
  const pitchScratch = new Float32Array(PERCUSSIVE_PITCH_RADIUS * 2 + 1);
  const frameScratch = new Float32Array(PITCH_COUNT);

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
      const index = frame * PITCH_COUNT + pitch;
      harmonic[index] = medianAlongTime(
        energies,
        frameCount,
        frame,
        pitch,
        HARMONIC_TIME_RADIUS,
        timeScratch,
      );
      percussive[index] = medianAlongPitch(
        energies,
        frame,
        pitch,
        PERCUSSIVE_PITCH_RADIUS,
        pitchScratch,
      );
    }
  }

  const enhanced = new Float32Array(energies.length);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = frame * PITCH_COUNT;
    for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
      const index = frameOffset + pitch;
      const energy = energies[index];
      const mask =
        harmonic[index] /
        (harmonic[index] + percussive[index] + MASK_EPSILON);
      enhanced[index] = energy * mask ** MASK_EXPONENT;
    }

    const floor = framePercentile(
      enhanced,
      frameOffset,
      FRAME_FLOOR_PERCENTILE,
      frameScratch,
    );
    for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
      const index = frameOffset + pitch;
      enhanced[index] = Math.max(0, enhanced[index] - floor);
    }
  }

  return enhanced;
}

function medianAlongTime(
  energies: Float32Array,
  frameCount: number,
  frame: number,
  pitch: number,
  radius: number,
  scratch: Float32Array,
): number {
  let count = 0;
  const first = Math.max(0, frame - radius);
  const last = Math.min(frameCount - 1, frame + radius);
  for (let current = first; current <= last; current += 1) {
    scratch[count] = energies[current * PITCH_COUNT + pitch];
    count += 1;
  }
  return medianSorted(scratch, count);
}

function medianAlongPitch(
  energies: Float32Array,
  frame: number,
  pitch: number,
  radius: number,
  scratch: Float32Array,
): number {
  let count = 0;
  const first = Math.max(0, pitch - radius);
  const last = Math.min(PITCH_COUNT - 1, pitch + radius);
  const frameOffset = frame * PITCH_COUNT;
  for (let current = first; current <= last; current += 1) {
    scratch[count] = energies[frameOffset + current];
    count += 1;
  }
  return medianSorted(scratch, count);
}

function framePercentile(
  values: Float32Array,
  frameOffset: number,
  percentile: number,
  scratch: Float32Array,
): number {
  for (let pitch = 0; pitch < PITCH_COUNT; pitch += 1) {
    scratch[pitch] = values[frameOffset + pitch];
  }
  scratch.subarray(0, PITCH_COUNT).sort();
  const index = clamp(
    Math.floor((PITCH_COUNT - 1) * percentile),
    0,
    PITCH_COUNT - 1,
  );
  return scratch[index];
}

function medianSorted(scratch: Float32Array, count: number): number {
  const slice = scratch.subarray(0, count);
  slice.sort();
  const middle = Math.floor(count / 2);
  if (count % 2 === 0) {
    return 0.5 * (slice[middle - 1] + slice[middle]);
  }
  return slice[middle];
}

function maxValue(values: Float32Array): number {
  let maximum = 0;
  for (let index = 0; index < values.length; index += 1) {
    maximum = Math.max(maximum, values[index]);
  }
  return maximum;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
    const contrasted =
      Math.max(
        0,
        (normalized - NORMALIZATION_FLOOR) / (1 - NORMALIZATION_FLOOR),
      ) ** NORMALIZATION_GAMMA;
    values[index] = Math.round(contrasted * 255);
  }
}
