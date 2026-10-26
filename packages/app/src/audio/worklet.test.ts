import { createDemoSong, createSong, type Song } from '@webtracker/engine';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineMessage, WorkletMessage } from './messages.ts';

/**
 * The tracker's AudioWorklet processor, run in-process: the test plays the
 * main thread, posting messages to its port and pulling blocks of audio.
 */

interface Processor {
  port: { onmessage: ((event: { data: EngineMessage }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

const RATE = 44100;
let Engine: new () => Processor;
let sent: WorkletMessage[];
let transfers: (Transferable[] | undefined)[];

beforeAll(async () => {
  const scope = globalThis as Record<string, unknown>;
  scope.sampleRate = RATE;
  scope.registerProcessor = (_name: string, cls: new () => Processor) => (Engine = cls);
  scope.AudioWorkletProcessor = class {
    port = {
      onmessage: null,
      postMessage: (message: WorkletMessage, transfer?: Transferable[]) => {
        sent.push(message);
        transfers.push(transfer);
      },
    };
  };
  const worklet = './worklet.ts';
  // A variable specifier keeps the type checker out of the worklet, which has its own project.
  await import(/* @vite-ignore */ worklet);
});

let engine: Processor;

beforeEach(() => {
  sent = [];
  transfers = [];
  engine = new Engine();
});

const post = (message: EngineMessage) => engine.port.onmessage!({ data: message });
const of = <T extends WorkletMessage['type']>(type: T) => sent.filter((m): m is Extract<WorkletMessage, { type: T }> => m.type === type);

/** Runs `blocks` blocks of 128 frames, stereo or mono, and returns the left channel. */
function run(blocks: number, mono = false): Float32Array {
  const left = new Float32Array(blocks * 128);
  for (let b = 0; b < blocks; b++) {
    const out = [new Float32Array(128), new Float32Array(128)];
    expect(engine.process([], [mono ? [out[0]!] : out])).toBe(true);
    left.set(out[0]!, b * 128);
  }
  return left;
}

const loud = (signal: Float32Array) => signal.some((v) => Math.abs(v) > 0.001);
/** Blocks in one row at the demo song's speed and tempo. */
const ROW = Math.ceil(((RATE * 2.5) / createDemoSong().initialTempo) * createDemoSong().initialSpeed / 128);

describe('engine worklet', () => {
  it('stays silent without a song or an output', () => {
    expect(loud(run(4))).toBe(false);
    expect(engine.process([], [])).toBe(true);
    expect(engine.process([], [[]])).toBe(true);
    post({ type: 'play', loopPattern: false });
    post({ type: 'stop' });
    post({ type: 'noteOn', note: 49, instrument: 1 });
    expect(sent).toEqual([]);
  });

  it('loads a song, plays it and reports rows with channel levels', () => {
    const song = createDemoSong();
    post({ type: 'load', song });
    expect(of('state')).toHaveLength(1);
    expect(loud(run(4))).toBe(false);
    post({ type: 'play', loopPattern: false });
    expect(loud(run(ROW * 4))).toBe(true);
    const rows = of('row');
    expect(rows.map((m) => m.state.row).slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(rows[0]!.levels).toHaveLength(song.channels);
    // Scopes go out as transferred buffers, and voices while there are any.
    const scopes = of('scopes');
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes[0]!.channels).toHaveLength(song.channels);
    const at = sent.indexOf(scopes[0]!);
    expect(transfers[at]).toEqual(scopes[0]!.channels.map((c) => c.buffer));
    expect(of('voices').length).toBeGreaterThan(0);
  });

  it('starts at a given order and row, and stop keeps the position', () => {
    post({ type: 'load', song: createDemoSong() });
    post({ type: 'play', loopPattern: true, order: 1, row: 4 });
    expect(of('state').at(-1)!.state).toMatchObject({ order: 1, row: 4, playing: true });
    run(ROW * 2);
    post({ type: 'stop' });
    const stopped = of('state').at(-1)!.state;
    expect(stopped.playing).toBe(false);
    expect(stopped.row).toBeGreaterThan(4);
    // Scopes rest while stopped.
    const scopes = of('scopes').length;
    run(ROW);
    expect(of('scopes')).toHaveLength(scopes);
    // Play without a position goes on from there; order alone starts at its row 0.
    post({ type: 'play', loopPattern: false });
    expect(of('state').at(-1)!.state).toMatchObject({ order: 1, row: stopped.row });
    post({ type: 'play', loopPattern: false, order: 0 });
    expect(of('state').at(-1)!.state).toMatchObject({ order: 0, row: 0 });
    post({ type: 'seek', order: 2 });
    expect(of('state').at(-1)!.state.order).toBe(2);
  });

  it('plays one row and stops quietly when the next one starts', () => {
    post({ type: 'load', song: createDemoSong() });
    sent = [];
    post({ type: 'playRow', order: 0, row: 0 });
    expect(sent).toEqual([]);
    expect(loud(run(ROW + 2))).toBe(true);
    expect(of('row')).toEqual([]);
    expect(of('state').at(-1)!.state).toMatchObject({ playing: false, row: 1 });
    // A play after a row-by-row play reports rows again.
    post({ type: 'play', loopPattern: false });
    run(ROW * 2);
    expect(of('row').length).toBeGreaterThan(0);
  });

  it('keeps muted channels and mixer settings across loads', () => {
    const song = createDemoSong();
    post({ type: 'mute', muted: Array(song.channels).fill(true) });
    post({ type: 'mixer', resampler: 'none', stereoSeparation: 0, volumeRamps: false, amplify: 100, karplusStrong: false });
    post({ type: 'load', song });
    post({ type: 'play', loopPattern: false });
    expect(loud(run(ROW * 4))).toBe(false);
    post({ type: 'mute', muted: Array(song.channels).fill(false) });
    const out = [new Float32Array(ROW * 128), new Float32Array(ROW * 128)];
    for (let b = 0; b < ROW * 4; b++) {
      const block = [new Float32Array(128), new Float32Array(128)];
      engine.process([], [block]);
      if (b < ROW) {
        out[0]!.set(block[0]!, b * 128);
        out[1]!.set(block[1]!, b * 128);
      }
    }
    // Stereo separation 0 is mono.
    expect(Array.from(out[0]!)).toEqual(Array.from(out[1]!));
    // Mixer settings sent while a song is loaded apply at once.
    post({ type: 'mixer', resampler: 'none', stereoSeparation: 0, volumeRamps: false, amplify: 0, karplusStrong: false });
    expect(loud(run(ROW))).toBe(false);
  });

  it('folds stereo down for a mono output', () => {
    post({ type: 'load', song: createDemoSong() });
    post({ type: 'play', loopPattern: false });
    expect(loud(run(ROW * 2, true))).toBe(true);
  });

  it('previews notes and stops them, and sends one empty voice list after the last', () => {
    post({ type: 'load', song: createDemoSong() });
    post({ type: 'noteOn', note: 49, instrument: 1 });
    expect(loud(run(8))).toBe(true);
    expect(of('voices').at(-1)!.voices.length).toBeGreaterThan(0);
    post({ type: 'noteOff' });
    run(ROW * 40);
    const lists = of('voices').map((m) => m.voices.length);
    expect(lists.at(-1)).toBe(0);
    expect(lists.filter((n) => n === 0)).toHaveLength(1);
  });

  it('takes live edits to patterns, instruments, orders and tempo', () => {
    const song: Song = createSong(4);
    post({ type: 'load', song });
    const pattern = structuredClone(song.patterns[0]!);
    post({ type: 'pattern', index: 0, pattern });
    expect(song.patterns[0]).toBe(pattern);
    const instrument = structuredClone(createDemoSong().instruments[1]!);
    post({ type: 'instrument', index: 0, instrument });
    expect(song.instruments[0]).toBe(instrument);
    post({ type: 'tempo', speed: 3, tempo: 150 });
    expect([song.initialSpeed, song.initialTempo]).toEqual([3, 150]);
    // Live edits do not send a state.
    expect(of('state')).toHaveLength(1);

    post({ type: 'orders', orders: [0, 0, 0], restartPosition: 1 });
    post({ type: 'seek', order: 2 });
    post({ type: 'orders', orders: [0], restartPosition: 0 });
    expect(song.orders).toEqual([0]);
    post({ type: 'play', loopPattern: false });
    expect(of('state').at(-1)!.state).toMatchObject({ order: 0, speed: 3, tempo: 150 });
  });

  it('ignores live edits before a song is loaded', () => {
    const song = createSong(4);
    post({ type: 'pattern', index: 0, pattern: song.patterns[0]! });
    post({ type: 'instrument', index: 0, instrument: song.instruments[0]! });
    post({ type: 'orders', orders: [0], restartPosition: 0 });
    post({ type: 'tempo', speed: 6, tempo: 125 });
    post({ type: 'playRow', order: 0, row: 0 });
    post({ type: 'seek', order: 0 });
    post({ type: 'noteOff' });
    expect(sent).toEqual([]);
  });
});
