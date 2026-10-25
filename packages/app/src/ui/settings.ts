/** Preferences that belong to the browser, not the song, kept in localStorage. */
import type { RawFormat } from '@webtracker/formats';
import type { Resampler } from '@webtracker/engine';

export const THEMES = {
  classic: 'Classic blue',
  midnight: 'Midnight',
  amber: 'Amber LCD',
  mint: 'Mint',
} as const;
export type Theme = keyof typeof THEMES;

export interface Settings {
  theme: Theme;
  /** How samples are resampled; 'auto' is Amiga for MOD and linear for XM. */
  resampler: Resampler;
  /** Stereo width in percent, 0..200. */
  stereoSeparation: number;
  /** Short volume ramps against clicks. */
  volumeRamps: boolean;
  /** Row highlight every n rows, and the stronger one; 0 is off. */
  beat: number;
  bar: number;
  /** 'ft2': Space stops, or toggles edit mode when stopped. 'play': Space plays and stops, Shift+Space toggles edit mode. */
  space: 'ft2' | 'play';
  midi: boolean;
  /** Write the MIDI velocity into the volume column while recording. */
  midiVelocity: boolean;
  /** New, loaded and shared songs open beside the current one instead of replacing it. */
  songTabs: boolean;
  /** How headerless sample files are read. */
  rawFormat: RawFormat;
}

export const DEFAULTS: Settings = {
  theme: 'classic',
  resampler: 'auto',
  stereoSeparation: 100,
  volumeRamps: true,
  beat: 4,
  bar: 16,
  space: 'ft2',
  midi: false,
  midiVelocity: false,
  songTabs: true,
  rawFormat: 's8',
};

const KEY = 'webtracker.settings';

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings> & { interpolation?: boolean };
    // Older versions only had an interpolation switch.
    if (stored.resampler === undefined && stored.interpolation === false) stored.resampler = 'none';
    delete stored.interpolation;
    const merged = { ...DEFAULTS, ...stored };
    if (!(merged.theme in THEMES)) merged.theme = DEFAULTS.theme;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be off (private windows); settings then last for the session.
  }
}

/** MIDI note number to XM note (1..96): MIDI 60 is C-4, which is XM note 49. */
export function midiToNote(midi: number): number | null {
  const note = midi - 11;
  return note >= 1 && note <= 96 ? note : null;
}

/** MIDI velocity 1..127 to an XM volume column value (0x10 + 0..64). */
export function velocityToVolume(velocity: number): number {
  return 0x10 + Math.max(0, Math.min(64, Math.round((velocity / 127) * 64)));
}
