export const DESIGN_COLORS = {
  background: '#F7F4F8',
  canvasBackground: '#FFFFFF',
  surface: '#FFFFFF',
  text: '#24232D',
  grid: '#E1DCE3',
  note: '#6D3CF7',
  keyActive: '#00ABB8',
  playhead: '#DD3FA3',
  playheadText: '#17131D',
  waveform: '#B7B0BC',
} as const;

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
