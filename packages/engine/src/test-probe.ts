/**
 * Measures what the replayer does, tick by tick, without estimating anything
 * from a waveform: the test sample is a constant level, so the output frame
 * is the channel's gain, and the voice position tells the exact pitch.
 */
import { createSong, writeCell } from './edit.ts';
import { Player, type PlayerState } from './player.ts';
import { LoopType, emptyEnvelope, emptyPattern, type Cell, type Instrument, type Song } from './song.ts';

export const SR = 44100;
/** Frames per tick at 125 BPM. */
export const TICK = SR / 50;

/** An instrument whose sample is a constant 0.5, long enough never to wrap during a test. */
export function dcInstrument(extra: Partial<Instrument> = {}, loop = true, frames = 1 << 18): Instrument {
  const data = new Float32Array(frames).fill(0.5);
  return {
    name: 'dc',
    samples: [
      {
        name: 'dc',
        data,
        loopStart: 0,
        loopLength: loop ? data.length : 0,
        loopType: loop ? LoopType.Forward : LoopType.None,
        volume: 64,
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
    ...extra,
  };
}

export interface ProbeSong {
  /** Rows of cells, one per channel. Missing rows and cells stay empty. */
  rows: (Partial<Cell> | undefined)[][];
  channels?: number;
  format?: Song['format'];
  compat?: Song['compat'];
  linear?: boolean;
  speed?: number;
  patternRows?: number;
  instruments?: Instrument[];
  /** Order list; every entry plays the same cells unless `patterns` gives more. */
  orders?: number[];
  patterns?: number;
}

export function probeSong(opts: ProbeSong): Song {
  const channels = opts.channels ?? 1;
  const song = createSong(channels);
  song.format = opts.format ?? 'xm';
  if (opts.compat) song.compat = opts.compat;
  song.linearFrequency = opts.linear ?? (song.format === 'xm' && !opts.compat);
  song.initialSpeed = opts.speed ?? 6;
  song.instruments = opts.instruments ?? [dcInstrument()];
  song.patterns = Array.from({ length: opts.patterns ?? 1 }, () => emptyPattern(opts.patternRows ?? 16, channels));
  song.orders = opts.orders ?? [0];
  opts.rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell) writeCell(song, song.patterns[0]!, r, c, cell);
    }),
  );
  return song;
}

export interface Tick {
  /** Frequency of the probed channel's voice during the tick in Hz; 0 when silent. */
  freq: number;
  /** Output level per side at the end of the tick, as a fraction of the sample level at full gain. */
  left: number;
  right: number;
  /** Both sides summed in power, so panning does not change it. */
  level: number;
}

export interface Probe {
  ticks: Tick[];
  /** Each row as it starts, with the tick it starts on. */
  rows: (PlayerState & { tick: number })[];
  player: Player;
}

/** Plays `ticks` ticks of `song` with ramps off and reports each of them. */
export function probe(song: Song, ticks: number, setup?: (p: Player) => void, channel = 0): Probe {
  const player = new Player(song, SR);
  player.volumeRamps = false;
  player.resampler = 'none';
  const rows: Probe['rows'] = [];
  let t = 0;
  player.onRow = (s) => rows.push({ ...s, tick: t });
  setup?.(player);
  player.playing = true;
  const left = new Float32Array(TICK);
  const right = new Float32Array(TICK);
  const out: Tick[] = [];
  const scale = 0.5 * player.masterGain;
  let lastPos = -1;
  let lastVoice: unknown = null;
  for (t = 0; t < ticks; t++) {
    player.process(left, right, TICK);
    const voice = player.voices().find((v) => v.channel === channel);
    const pos = voice?.pos ?? -1;
    const freq = voice && lastPos >= 0 && voice.pos > lastPos && lastVoice !== null ? ((pos - lastPos) * SR) / TICK : 0;
    lastPos = pos;
    lastVoice = voice ?? null;
    // The mix is in 32-bit floats; six places hide its rounding.
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    const l = left[TICK - 1]! / scale;
    const r = right[TICK - 1]! / scale;
    out.push({ freq, left: round(l), right: round(r), level: round(Math.hypot(l, r)) });
  }
  return { ticks: out, rows, player };
}

/** Semitones from `ref` Hz, rounded to hundredths. */
export const semis = (hz: number, ref: number) => Math.round(1200 * Math.log2(hz / ref)) / 100;
