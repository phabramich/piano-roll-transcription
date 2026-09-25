/*
 * Persistent cache for MuScriptor results, keyed by file content hash.
 * Stores only the note list + MIDI — the ~5 MB frame-probability grid is
 * derived data repainted from notes on load, so an entry is a few KB of
 * JSON and fits in localStorage easily.
 * ponytail: no eviction — entries are KBs; a quota error just skips caching.
 */

const KEY_PREFIX = 'muscriptor-small-q8_0:';
const MAX_ENTRIES = 50;

export interface CachedNote {
  pitchMidi: number;
  amplitude: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  instrument?: string;
}

export interface CachedPrecise {
  durationSeconds: number;
  notes: CachedNote[];
  midiBase64?: string;
}

export async function fingerprintFile(file: File): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    let hex = '';
    for (const byte of new Uint8Array(digest)) {
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null;
  }
}

export function getCachedPrecise(fileHash: string): CachedPrecise | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + fileHash);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' || parsed === null ||
      !Array.isArray((parsed as CachedPrecise).notes)
    ) {
      return null;
    }
    return parsed as CachedPrecise;
  } catch {
    return null;
  }
}

function prefixedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(KEY_PREFIX)) {
      keys.push(key);
    }
  }
  return keys;
}

export function cachePrecise(fileHash: string, payload: CachedPrecise): void {
  try {
    const keys = prefixedKeys();
    while (keys.length >= MAX_ENTRIES) {
      localStorage.removeItem(keys.shift() as string);
    }
    localStorage.setItem(KEY_PREFIX + fileHash, JSON.stringify(payload));
  } catch {
    // Quota or privacy mode — cache is best-effort.
  }
}

export function clearPreciseCache(): void {
  try {
    for (const key of prefixedKeys()) {
      localStorage.removeItem(key);
    }
  } catch {
    // Privacy mode — nothing to clear.
  }
}

export function midiFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function midiToBase64(midi: Uint8Array): string {
  let binary = '';
  for (const byte of midi) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
