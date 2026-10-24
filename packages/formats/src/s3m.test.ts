import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOTE_KEY_OFF } from '@webtracker/engine';
import { loadModule } from './index.ts';
import { convertEffect } from './s3m.ts';
import { buildS3m, squareWave } from './test-builders.ts';
import { SR, estimateFrequency, render } from './test-render.ts';

const C4 = 0x40; // octave 4, C

describe('S3M loader', () => {
  it('reads header, samples, orders and channels', () => {
    const song = loadModule(
      buildS3m({
        title: 'scream',
        samples: [{ data: squareWave(64), volume: 48, loopStart: 0, loopEnd: 64 }],
        patterns: [[[{ note: C4, ins: 1, vol: 32, cmd: 'A', info: 3 }]], []],
        orders: [1, 254, 0, 255, 0],
        speed: 4,
        tempo: 150,
      }),
    );
    expect(song.formatName).toBe('Scream Tracker 3.20 S3M');
    expect(song.title).toBe('scream');
    expect(song.linearFrequency).toBe(false);
    expect(song.channels).toBe(4);
    expect(song.orders).toEqual([1, 0]);
    expect(song.initialSpeed).toBe(4);
    expect(song.initialTempo).toBe(150);
    expect(song.initialGlobalVolume).toBe(64);
    expect(song.channelPanning).toEqual([0x33, 0xcc, 0xcc, 0x33]);
    const s = song.instruments[0]!.samples[0]!;
    expect(s.volume).toBe(48);
    expect(s.loopLength).toBe(64);
    expect(s.data[0]).toBeCloseTo(100 / 128);
    expect(s.data[40]).toBeCloseTo(-100 / 128);
    expect(Array.from(song.patterns[0]!.data.subarray(0, 5))).toEqual([49, 1, 0x30, 0x0f, 3]);
  });

  it('maps note cut, disabled channels and the pan table', () => {
    const song = loadModule(
      buildS3m({
        samples: [],
        patterns: [[[undefined, undefined, { note: 254 }, { note: 0x52 }]]],
        orders: [0],
        channelSettings: [0, 255, 8, 1],
        panning: [3, 0, 15, 7],
      }),
    );
    expect(song.channels).toBe(3);
    expect(song.channelPanning).toEqual([51, 255, 119]);
    const d = song.patterns[0]!.data;
    expect(d[5]).toBe(NOTE_KEY_OFF);
    expect(d[10]).toBe(5 * 12 + 2 + 1);
  });

  it('gives mono songs centred channels', () => {
    const song = loadModule(buildS3m({ samples: [], patterns: [[]], orders: [0], mono: true }));
    expect(song.channelPanning).toEqual([128, 128, 128, 128]);
  });

  it('plays C-4 at the sample C2Spd', () => {
    const song = loadModule(
      buildS3m({
        samples: [{ data: squareWave(32), c2spd: 16726, loopStart: 0, loopEnd: 32 }],
        patterns: [[[{ note: C4, ins: 1 }]]],
        orders: [0],
      }),
    );
    const out = render(song, 0.5).left;
    // 16726 Hz through a 32 sample cycle.
    expect(estimateFrequency(out, SR * 0.1, SR * 0.4)).toBeCloseTo(16726 / 32, -1);
  });

  it('converts commands to XM effects', () => {
    const c = (letter: string, info: number) => convertEffect(letter.charCodeAt(0) - 64, info);
    expect(c('A', 0x40)).toEqual([0x0f, 31]);
    expect(c('A', 0)).toEqual([0, 0]);
    expect(c('D', 0x0f)).toEqual([0x0a, 0x0f]);
    expect(c('D', 0xf3)).toEqual([0x0e, 0xb3]);
    expect(c('D', 0x3f)).toEqual([0x0e, 0xa3]);
    expect(c('D', 0x32)).toEqual([0x0a, 0x30]);
    expect(c('E', 0x20)).toEqual([0x02, 0x20]);
    expect(c('E', 0xf4)).toEqual([0x0e, 0x24]);
    expect(c('F', 0xe4)).toEqual([0x21, 0x14]);
    expect(c('I', 0x31)).toEqual([0x1d, 0x31]);
    expect(c('J', 0x47)).toEqual([0x00, 0x47]);
    expect(c('Q', 0x13)).toEqual([0x1b, 0x13]);
    expect(c('S', 0x84)).toEqual([0x08, 68]);
    expect(c('S', 0xb2)).toEqual([0x0e, 0x62]);
    expect(c('S', 0xd3)).toEqual([0x0e, 0xd3]);
    expect(c('T', 0x90)).toEqual([0x0f, 0x90]);
    expect(c('T', 0x10)).toEqual([0, 0]);
    expect(c('V', 0x80)).toEqual([0x10, 64]);
    expect(c('X', 0x40)).toEqual([0x08, 0x80]);
    expect(c('X', 0xa4)).toEqual([0, 0]);
  });

  it('loads a Scream Tracker file from disk when one is given', () => {
    const path = process.env.S3M_FILE;
    if (!path) return;
    const file = readFileSync(path);
    const song = loadModule(file.buffer.slice(file.byteOffset, file.byteOffset + file.length) as ArrayBuffer);
    expect(song.patterns.length).toBeGreaterThan(0);
  });
});
