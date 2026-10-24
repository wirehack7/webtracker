/**
 * Format-independent song model. MOD files are converted into this model
 * with XM semantics (Amiga frequency table, one sample per instrument),
 * so a single replayer handles both formats.
 */

export const NOTE_NONE = 0;
/** Notes 1..96 are C-0..B-7 (XM numbering). */
export const NOTE_KEY_OFF = 97;

/** Bytes per pattern cell: note, instrument, volume column, effect, param. */
export const CELL_SIZE = 5;

export const LoopType = { None: 0, Forward: 1, PingPong: 2 } as const;
export type LoopType = (typeof LoopType)[keyof typeof LoopType];

export interface Sample {
  name: string;
  /** Normalised PCM in -1..1. */
  data: Float32Array;
  loopStart: number;
  loopLength: number;
  loopType: LoopType;
  /** 0..64 */
  volume: number;
  /** -128..127, 1/128 semitone steps. */
  finetune: number;
  /** 0..255 */
  panning: number;
  relativeNote: number;
}

export interface EnvelopePoint {
  /** Position in ticks. */
  x: number;
  /** 0..64 */
  y: number;
}

export interface Envelope {
  enabled: boolean;
  points: EnvelopePoint[];
  sustain: boolean;
  sustainPoint: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
}

export interface Instrument {
  name: string;
  samples: Sample[];
  /** Note (0..95) to sample index. */
  keymap: Uint8Array;
  volumeEnvelope: Envelope;
  panningEnvelope: Envelope;
  fadeout: number;
  vibratoType: number;
  vibratoSweep: number;
  vibratoDepth: number;
  vibratoRate: number;
}

export interface Pattern {
  rows: number;
  /** rows * channels * CELL_SIZE bytes. */
  data: Uint8Array;
}

export interface Song {
  format: 'mod' | 'xm';
  /** Human readable format detail, e.g. "ProTracker M.K." or "FastTracker 2 XM 1.04". */
  formatName: string;
  title: string;
  channels: number;
  orders: number[];
  restartPosition: number;
  patterns: Pattern[];
  instruments: Instrument[];
  linearFrequency: boolean;
  initialSpeed: number;
  initialTempo: number;
  /** Initial panning per channel, 0..255. */
  channelPanning: number[];
}

export interface Cell {
  note: number;
  instrument: number;
  volume: number;
  effect: number;
  param: number;
}

export function readCell(song: Song, pattern: Pattern, row: number, channel: number): Cell {
  const o = (row * song.channels + channel) * CELL_SIZE;
  const [note = 0, instrument = 0, volume = 0, effect = 0, param = 0] = pattern.data.subarray(o, o + CELL_SIZE);
  return { note, instrument, volume, effect, param };
}

export function emptyEnvelope(): Envelope {
  return { enabled: false, points: [], sustain: false, sustainPoint: 0, loop: false, loopStart: 0, loopEnd: 0 };
}

export function emptyPattern(rows: number, channels: number): Pattern {
  return { rows, data: new Uint8Array(rows * channels * CELL_SIZE) };
}
