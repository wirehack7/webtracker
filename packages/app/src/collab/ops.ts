/**
 * Jam operations: the changes people in a jam send each other. Each one sets
 * part of the song to a value (it never says "add" or "move"), so applying
 * the same operations in the same order gives the same song everywhere.
 */

import { CELL_SIZE, emptyInstrument, ensurePattern, type Instrument, type Song } from '@webtracker/engine';
import type { SongEdit } from '../editor/song-editor.ts';

export type Op =
  /** Cells of a pattern: `cells` holds cell numbers (row * channels + channel), `bytes` their contents. */
  | { k: 'cells'; p: number; cells: Uint32Array; bytes: Uint8Array }
  /** A whole pattern, when its length changed. */
  | { k: 'pattern'; p: number; rows: number; data: Uint8Array }
  | { k: 'orders'; orders: number[]; restart: number }
  /**
   * An instrument. With `keepData` its samples carry no sample data and keep
   * what the receiver has, which keeps knob turns small.
   */
  | { k: 'instrument'; i: number; ins: Instrument; keepData: boolean }
  | { k: 'tempo'; speed: number; tempo: number }
  | { k: 'title'; title: string }
  /** Channel count or a song-wide tool: everything but tempo, title and the like. */
  | { k: 'layout'; layout: Layout };

/** The parts of a song that channel changes and song-wide tools rewrite. */
export type Layout = Pick<Song, 'channels' | 'channelPanning' | 'patterns' | 'orders' | 'restartPosition' | 'instruments'> & {
  channelVolume?: number[];
};

export function layoutOf(song: Song): Layout {
  const { channels, channelPanning, patterns, orders, restartPosition, instruments, channelVolume } = song;
  return structuredClone({ channels, channelPanning, patterns, orders, restartPosition, instruments, ...(channelVolume && { channelVolume }) });
}

const NO_DATA = new Float32Array(0);

/** A copy of the instrument, without sample data when `withData` is false. */
export function instrumentCopy(ins: Instrument, withData: boolean): Instrument {
  const env = (e: Instrument['volumeEnvelope']) => ({ ...e, points: e.points.map((p) => ({ ...p })) });
  return {
    ...ins,
    samples: ins.samples.map((s) => ({ ...s, data: withData ? s.data.slice() : NO_DATA })),
    keymap: ins.keymap.slice(),
    volumeEnvelope: env(ins.volumeEnvelope),
    panningEnvelope: env(ins.panningEnvelope),
  };
}

/** Applies `op` to `song` in place and says what it touched. */
export function applyOp(song: Song, op: Op): SongEdit {
  switch (op.k) {
    case 'cells': {
      const pattern = ensurePattern(song, op.p);
      op.cells.forEach((cell, i) => {
        // A cell beyond the end belongs to rows someone has since removed.
        if ((cell + 1) * CELL_SIZE <= pattern.data.length) {
          pattern.data.set(op.bytes.subarray(i * CELL_SIZE, (i + 1) * CELL_SIZE), cell * CELL_SIZE);
        }
      });
      return { kind: 'pattern', index: op.p };
    }
    case 'pattern':
      ensurePattern(song, op.p);
      song.patterns[op.p] = { rows: op.rows, data: op.data.slice() };
      return { kind: 'pattern', index: op.p };
    case 'orders':
      song.orders = [...op.orders];
      for (const p of song.orders) ensurePattern(song, p);
      song.restartPosition = op.restart < song.orders.length ? op.restart : 0;
      return { kind: 'orders' };
    case 'instrument': {
      const old = song.instruments[op.i];
      const ins = instrumentCopy(op.ins, true);
      if (op.keepData) ins.samples.forEach((s, j) => (s.data = old?.samples[j]?.data ?? NO_DATA));
      while (song.instruments.length < op.i) song.instruments.push(emptyInstrument());
      song.instruments[op.i] = ins;
      return { kind: 'instrument', index: op.i };
    }
    case 'tempo':
      song.initialSpeed = op.speed;
      song.initialTempo = op.tempo;
      return { kind: 'tempo' };
    case 'title':
      song.title = op.title;
      return { kind: 'title' };
    case 'layout': {
      const { channelVolume, ...rest } = structuredClone(op.layout);
      Object.assign(song, rest);
      if (channelVolume) song.channelVolume = channelVolume;
      else delete song.channelVolume;
      return { kind: 'song' };
    }
  }
}
