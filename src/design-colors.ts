export interface DesignColors {
  background: string;
  canvasBackground: string;
  surface: string;
  text: string;
  grid: string;
  note: string;
  keyActive: string;
  playhead: string;
  playheadText: string;
  waveform: string;
}

const LIGHT_COLORS: DesignColors = {
  background: '#F7F8F7',
  canvasBackground: '#FFFFFF',
  surface: '#FFFFFF',
  text: '#1E2423',
  grid: '#E4EAE6',
  note: '#7C3AED',
  keyActive: '#FFB03C',
  playhead: '#E0245E',
  playheadText: '#17131D',
  waveform: '#AEBFC3',
};

const DARK_COLORS: DesignColors = {
  background: '#14323D',
  canvasBackground: '#183A46',
  surface: '#1C3F4B',
  text: '#ECE7D3',
  grid: '#22424E',
  note: '#B48CFF',
  keyActive: '#FFB03C',
  playhead: '#FF5C7A',
  playheadText: '#1C1206',
  waveform: '#3D5C68',
};

// Mutable on purpose: renderers read it every frame, so a theme switch just
// swaps values in place and the next paint picks them up.
export const DESIGN_COLORS: DesignColors = { ...LIGHT_COLORS };

export function applyDesignTheme(theme: 'light' | 'dark'): void {
  Object.assign(DESIGN_COLORS, theme === 'dark' ? DARK_COLORS : LIGHT_COLORS);
}

const INSTRUMENT_FAMILY_COLORS: Record<string, string> = {
  acoustic_piano: '#6D3CF7',
  electric_piano: '#7C5CFC',
  chromatic_percussion: '#8B7CF6',
  organ: '#8F4BE8',
  acoustic_guitar: '#E07B00',
  clean_electric_guitar: '#F25A1C',
  distorted_electric_guitar: '#D93A2B',
  acoustic_bass: '#A8550B',
  electric_bass: '#C2410C',
  violin: '#0E9F6E',
  viola: '#10B981',
  cello: '#047857',
  contrabass: '#065F46',
  orchestral_harp: '#34C38F',
  timpani: '#7A6F66',
  string_ensemble: '#0E9F6E',
  synth_strings: '#4ADE80',
  voice: '#DB2777',
  orchestra_hit: '#6B6560',
  trumpet: '#CA8A04',
  trombone: '#B8860B',
  tuba: '#A16207',
  french_horn: '#D9A404',
  brass_section: '#CA8A04',
  soprano_and_alto_sax: '#0D9488',
  tenor_sax: '#0F766E',
  baritone_sax: '#115E59',
  oboe: '#0891B2',
  english_horn: '#0E7490',
  bassoon: '#155E75',
  clarinet: '#0EA5C4',
  flutes: '#22B8D4',
  synth_lead: '#2563EB',
  synth_pad: '#3B82F6',
};

export function instrumentColor(instrument: string | undefined): string {
  if (instrument === undefined) {
    return DESIGN_COLORS.note;
  }
  const known = INSTRUMENT_FAMILY_COLORS[instrument];
  return known ?? '#64748B';
}
