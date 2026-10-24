/**
 * Editing operations on the song model. They change patterns in place and
 * know nothing about undo or the UI; callers snapshot what they need.
 */

import { CELL_SIZE, emptyEnvelope, emptyPattern, LoopType, NOTE_KEY_OFF, type Cell, type Instrument, type Pattern, type Song } from './song.ts';

export const MAX_ROWS = 256;
export const MAX_PATTERNS = 256;
export const MAX_ORDERS = 256;
export const MAX_CHANNELS = 32;

/** A rectangle of cells, inclusive on all sides, with row0 <= row1 and ch0 <= ch1. */
export interface Block {
  row0: number;
  row1: number;
  ch0: number;
  ch1: number;
}

/** Cells copied out of a pattern. */
export interface Clip {
  rows: number;
  channels: number;
  data: Uint8Array;
}

/** Normalises two corners into a block. */
export function blockBetween(rowA: number, chA: number, rowB: number, chB: number): Block {
  return {
    row0: Math.min(rowA, rowB),
    row1: Math.max(rowA, rowB),
    ch0: Math.min(chA, chB),
    ch1: Math.max(chA, chB),
  };
}

function cellOffset(song: Song, row: number, channel: number): number {
  return (row * song.channels + channel) * CELL_SIZE;
}

/** Clips the block to the pattern so callers can pass loose bounds. */
function clamp(song: Song, pattern: Pattern, block: Block): Block {
  return {
    row0: Math.max(0, block.row0),
    row1: Math.min(pattern.rows - 1, block.row1),
    ch0: Math.max(0, block.ch0),
    ch1: Math.min(song.channels - 1, block.ch1),
  };
}

/** Sets the given fields of one cell. */
export function writeCell(song: Song, pattern: Pattern, row: number, channel: number, cell: Partial<Cell>): void {
  if (row < 0 || row >= pattern.rows || channel < 0 || channel >= song.channels) return;
  const o = cellOffset(song, row, channel);
  const d = pattern.data;
  if (cell.note !== undefined) d[o] = cell.note;
  if (cell.instrument !== undefined) d[o + 1] = cell.instrument;
  if (cell.volume !== undefined) d[o + 2] = cell.volume;
  if (cell.effect !== undefined) d[o + 3] = cell.effect;
  if (cell.param !== undefined) d[o + 4] = cell.param;
}

export function copyBlock(song: Song, pattern: Pattern, block: Block): Clip {
  const b = clamp(song, pattern, block);
  const rows = Math.max(0, b.row1 - b.row0 + 1);
  const channels = Math.max(0, b.ch1 - b.ch0 + 1);
  const data = new Uint8Array(rows * channels * CELL_SIZE);
  for (let r = 0; r < rows; r++) {
    const src = cellOffset(song, b.row0 + r, b.ch0);
    data.set(pattern.data.subarray(src, src + channels * CELL_SIZE), r * channels * CELL_SIZE);
  }
  return { rows, channels, data };
}

export function clearBlock(song: Song, pattern: Pattern, block: Block): void {
  const b = clamp(song, pattern, block);
  for (let r = b.row0; r <= b.row1; r++) {
    pattern.data.fill(0, cellOffset(song, r, b.ch0), cellOffset(song, r, b.ch1 + 1));
  }
}

/**
 * Pastes a clip with its top-left corner at (row, channel). Cells that fall
 * outside the pattern are dropped. With `mix`, only empty fields are filled,
 * so existing notes and effects survive.
 */
export function pasteClip(song: Song, pattern: Pattern, row: number, channel: number, clip: Clip, mix = false): void {
  for (let r = 0; r < clip.rows; r++) {
    const pr = row + r;
    if (pr < 0 || pr >= pattern.rows) continue;
    for (let c = 0; c < clip.channels; c++) {
      const pc = channel + c;
      if (pc < 0 || pc >= song.channels) continue;
      const src = (r * clip.channels + c) * CELL_SIZE;
      const dst = cellOffset(song, pr, pc);
      for (let k = 0; k < CELL_SIZE; k++) {
        const value = clip.data[src + k] ?? 0;
        if (!mix || pattern.data[dst + k] === 0) pattern.data[dst + k] = value;
      }
    }
  }
}

/**
 * Moves every note in the block by `semitones`. Key-offs stay, and notes
 * that would leave C-0..B-7 are left alone, as in FT2. Returns how many
 * notes changed.
 */
export function transposeBlock(song: Song, pattern: Pattern, block: Block, semitones: number): number {
  const b = clamp(song, pattern, block);
  let changed = 0;
  for (let r = b.row0; r <= b.row1; r++) {
    for (let c = b.ch0; c <= b.ch1; c++) {
      const o = cellOffset(song, r, c);
      const note = pattern.data[o] ?? 0;
      if (note === 0 || note === NOTE_KEY_OFF) continue;
      const moved = note + semitones;
      if (moved < 1 || moved > 96) continue;
      pattern.data[o] = moved;
      changed++;
    }
  }
  return changed;
}

/** Inserts an empty row at `row` in channels ch0..ch1; the last row falls off. */
export function insertRow(song: Song, pattern: Pattern, row: number, ch0: number, ch1: number): void {
  const b = clamp(song, pattern, { row0: row, row1: pattern.rows - 1, ch0, ch1 });
  const width = (b.ch1 - b.ch0 + 1) * CELL_SIZE;
  for (let r = b.row1; r > b.row0; r--) {
    const src = cellOffset(song, r - 1, b.ch0);
    pattern.data.copyWithin(cellOffset(song, r, b.ch0), src, src + width);
  }
  clearBlock(song, pattern, { row0: b.row0, row1: b.row0, ch0: b.ch0, ch1: b.ch1 });
}

/** Removes `row` in channels ch0..ch1 and pulls the rows below up. */
export function deleteRow(song: Song, pattern: Pattern, row: number, ch0: number, ch1: number): void {
  const b = clamp(song, pattern, { row0: row, row1: pattern.rows - 1, ch0, ch1 });
  const width = (b.ch1 - b.ch0 + 1) * CELL_SIZE;
  for (let r = b.row0; r < b.row1; r++) {
    const src = cellOffset(song, r + 1, b.ch0);
    pattern.data.copyWithin(cellOffset(song, r, b.ch0), src, src + width);
  }
  clearBlock(song, pattern, { row0: b.row1, row1: b.row1, ch0: b.ch0, ch1: b.ch1 });
}

/** A copy of the pattern with a new length, keeping the rows that still fit. */
export function resizePattern(song: Song, pattern: Pattern, rows: number): Pattern {
  const length = Math.max(1, Math.min(MAX_ROWS, rows));
  const resized = emptyPattern(length, song.channels);
  resized.data.set(pattern.data.subarray(0, Math.min(pattern.data.length, resized.data.length)));
  return resized;
}

/**
 * Changes the channel count of the whole song. Channels past the new count
 * are dropped from every pattern; new channels start empty and centred.
 */
export function setChannelCount(song: Song, channels: number): void {
  const count = Math.max(1, Math.min(MAX_CHANNELS, Math.floor(channels)));
  const old = song.channels;
  if (count === old) return;
  const keep = Math.min(old, count) * CELL_SIZE;
  song.patterns = song.patterns.map((p) => {
    const next = emptyPattern(p.rows, count);
    for (let r = 0; r < p.rows; r++) {
      next.data.set(p.data.subarray(r * old * CELL_SIZE, r * old * CELL_SIZE + keep), r * count * CELL_SIZE);
    }
    return next;
  });
  song.channelPanning = Array.from({ length: count }, (_, c) => song.channelPanning[c] ?? 128);
  song.channels = count;
}

/** Returns the pattern at `index`, appending empty 64-row patterns up to it. */
export function ensurePattern(song: Song, index: number): Pattern {
  while (song.patterns.length <= index) song.patterns.push(emptyPattern(64, song.channels));
  return song.patterns[index]!;
}

// ---- New songs ---------------------------------------------------------------

/**
 * Chip waveforms, 32 frames per cycle. Played at 8363 Hz for C-4 they sound
 * at 261 Hz, close to the real C-4 (261.6 Hz), so no relative note is needed.
 */
const WAVE_FRAMES = 32;

function waveform(shape: (phase: number) => number): Float32Array {
  return Float32Array.from({ length: WAVE_FRAMES }, (_, i) => shape(i / WAVE_FRAMES));
}

function chipInstrument(name: string, data: Float32Array): Instrument {
  return {
    name,
    samples: [
      {
        name,
        data,
        loopStart: 0,
        loopLength: data.length,
        loopType: LoopType.Forward,
        volume: 48,
        finetune: 0,
        panning: 128,
        relativeNote: 0,
      },
    ],
    keymap: new Uint8Array(96),
    volumeEnvelope: emptyEnvelope(),
    panningEnvelope: emptyEnvelope(),
    fadeout: 0,
    vibratoType: 0,
    vibratoSweep: 0,
    vibratoDepth: 0,
    vibratoRate: 0,
  };
}

/** 8-bit levels, so a song saved as XM stores these waves exactly. */
const HIGH = 96 / 128;

export function chipInstruments(): Instrument[] {
  return [
    chipInstrument('Square 50%', waveform((p) => (p < 0.5 ? HIGH : -HIGH))),
    chipInstrument('Pulse 25%', waveform((p) => (p < 0.25 ? HIGH : -HIGH))),
    chipInstrument('Pulse 12.5%', waveform((p) => (p < 0.125 ? HIGH : -HIGH))),
    chipInstrument('Triangle', waveform((p) => Math.round((p < 0.5 ? 4 * p - 1 : 3 - 4 * p) * 96) / 128)),
    chipInstrument('Saw', waveform((p) => Math.round((2 * p - 1) * 96) / 128)),
  ];
}

/** An empty XM song the way FT2 starts: speed 6, 125 BPM, one 64-row pattern. */
export function createSong(channels = 4): Song {
  return {
    format: 'xm',
    formatName: 'XM 1.04 (webtracker)',
    title: '',
    channels,
    orders: [0],
    restartPosition: 0,
    patterns: [emptyPattern(64, channels)],
    instruments: chipInstruments(),
    linearFrequency: true,
    initialSpeed: 6,
    initialTempo: 125,
    channelPanning: new Array<number>(channels).fill(128),
  };
}
