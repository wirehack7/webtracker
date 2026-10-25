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

/** The colours the scheme editor offers, by CSS custom property, with their labels. */
export const COLOR_VARS: [string, string][] = [
  ['--desk', 'Panels'],
  ['--desk-hi', 'Panel light'],
  ['--desk-lo', 'Panel shadow'],
  ['--btn', 'Buttons'],
  ['--btn-hi', 'Button light'],
  ['--btn-lo', 'Button shadow'],
  ['--btn-on', 'Button on'],
  ['--text', 'Text'],
  ['--label', 'Labels'],
  ['--dim', 'Dim text'],
  ['--field-bg', 'Field'],
  ['--field-fg', 'Field text'],
  ['--list-sel', 'List selection'],
  ['--pat-bg', 'Pattern'],
  ['--pat-rowhl', 'Highlight'],
  ['--pat-rowhl2', 'Highlight 2'],
  ['--pat-cursor', 'Cursor row'],
  ['--pat-cell', 'Cursor'],
  ['--pat-sel', 'Selection'],
  ['--pat-rec', 'Edit mode row'],
  ['--pat-rn', 'Row numbers'],
  ['--pat-sep', 'Separators'],
  ['--pat-note', 'Notes'],
  ['--pat-instr', 'Instruments'],
  ['--pat-vol', 'Volume, waveform'],
  ['--pat-fx', 'Effects'],
  ['--pat-param', 'Parameters'],
  ['--pat-empty', 'Empty cells'],
  ['--scope-line', 'Scopes'],
  ['--play-marker', 'Play marker'],
];

export interface Settings {
  theme: Theme;
  /** How samples are resampled; 'auto' is Amiga for MOD and linear for XM. */
  resampler: Resampler;
  /** Stereo width in percent, 0..200. */
  stereoSeparation: number;
  /** Short volume ramps against clicks. */
  volumeRamps: boolean;
  /** Output amplification in percent, 25..400. */
  amplify: number;
  /** Colours changed in the scheme editor, by CSS custom property, over the theme. */
  colors: Record<string, string>;
  /** MOD E8x runs ProTracker's Karplus-Strong filter instead of being ignored. */
  karplusStrong: boolean;
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
  /** Show the neighbouring patterns, dimmed, above and below the current one. */
  prospective: boolean;
  /** The cursor wraps from the last row to the first and back. */
  wrapCursor: boolean;
  /** How headerless sample files are read. */
  rawFormat: RawFormat;
}

export const DEFAULTS: Settings = {
  theme: 'classic',
  resampler: 'auto',
  stereoSeparation: 100,
  volumeRamps: true,
  amplify: 100,
  colors: {},
  karplusStrong: false,
  beat: 4,
  bar: 16,
  space: 'ft2',
  midi: false,
  midiVelocity: false,
  songTabs: true,
  prospective: false,
  wrapCursor: true,
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
    merged.colors = parseColors(merged.colors);
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

/** Keeps only known colour properties with #rrggbb values, from stored or imported data. */
export function parseColors(value: unknown): Record<string, string> {
  const colors: Record<string, string> = {};
  if (!value || typeof value !== 'object') return colors;
  for (const [name] of COLOR_VARS) {
    const v = (value as Record<string, unknown>)[name];
    if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) colors[name] = v.toLowerCase();
  }
  return colors;
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
