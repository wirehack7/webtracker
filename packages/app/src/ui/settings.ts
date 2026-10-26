/** Preferences that belong to the browser, not the song, kept in localStorage. */
import type { RawFormat } from '@webtracker/formats';
import type { Resampler } from '@webtracker/engine';
import { msg } from '../i18n/i18n.ts';

export const THEMES = {
  classic: msg('Classic blue'),
  midnight: msg('Midnight'),
  amber: msg('Amber LCD'),
  mint: msg('Mint'),
} as const;
export type Theme = keyof typeof THEMES;

/** Interface sizes for screens bigger than a phone; phones keep their own. */
export const UI_SIZES = {
  auto: msg('Auto'),
  small: msg('Small'),
  compact: msg('Compact'),
  medium: msg('Medium'),
  large: msg('Large'),
} as const;
export type UiSize = keyof typeof UI_SIZES;

const UI_PX: Record<Exclude<UiSize, 'auto'>, number> = { small: 1, compact: 1.25, medium: 1.5, large: 2 };

/**
 * CSS pixels per font pixel for an interface size, rounded to whole device
 * pixels: the 8x8 font smears when one of its pixels covers part of one.
 * Below 1280px wide it stays at or under medium so the panels fit.
 */
export function uiPixel(size: UiSize, coarse: boolean, dpr: number, width = Infinity): number {
  const ratio = dpr > 0 ? dpr : 1;
  const wanted = UI_PX[size === 'auto' ? (coarse ? 'medium' : 'compact') : size];
  let device = Math.round(wanted * ratio);
  if (width < 1280) device = Math.min(device, Math.floor(UI_PX.medium * ratio));
  return Math.max(1, device) / ratio;
}

/** The colours the scheme editor offers, by CSS custom property, with their labels. */
export const COLOR_VARS: [string, string][] = [
  ['--desk', msg('Panels')],
  ['--desk-hi', msg('Panel light')],
  ['--desk-lo', msg('Panel shadow')],
  ['--btn', msg('Buttons')],
  ['--btn-hi', msg('Button light')],
  ['--btn-lo', msg('Button shadow')],
  ['--btn-on', msg('Button on')],
  ['--text', msg('Text')],
  ['--label', msg('Labels')],
  ['--dim', msg('Dim text')],
  ['--field-bg', msg('Field')],
  ['--field-fg', msg('Field text')],
  ['--list-sel', msg('List selection')],
  ['--pat-bg', msg('Pattern')],
  ['--pat-rowhl', msg('Highlight')],
  ['--pat-rowhl2', msg('Highlight 2')],
  ['--pat-cursor', msg('Cursor row')],
  ['--pat-cell', msg('Cursor')],
  ['--pat-sel', msg('Selection')],
  ['--pat-rec', msg('Edit mode row')],
  ['--pat-rn', msg('Row numbers')],
  ['--pat-sep', msg('Separators')],
  ['--pat-note', msg('Notes')],
  ['--pat-instr', msg('Instruments')],
  ['--pat-vol', msg('Volume, waveform')],
  ['--pat-fx', msg('Effects')],
  ['--pat-param', msg('Parameters')],
  ['--pat-empty', msg('Empty cells')],
  ['--scope-line', msg('Scopes')],
  ['--play-marker', msg('Play marker')],
];

export interface Settings {
  /** A language code from LANGUAGES, or 'auto' for the browser's language. */
  language: string;
  theme: Theme;
  /** 'auto' is compact with a mouse and medium on tablets. */
  uiSize: UiSize;
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
  language: 'auto',
  theme: 'classic',
  uiSize: 'auto',
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
    if (!(merged.uiSize in UI_SIZES)) merged.uiSize = DEFAULTS.uiSize;
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
