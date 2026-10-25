import { describe, expect, it } from 'vitest';
import { NOTE_KEY_OFF } from '@webtracker/engine';
import { loadModule } from './index.ts';
import { convertEffect as convertOkt } from './okt.ts';
import { build669, buildMtm, buildOkt, squareWave } from './test-builders.ts';
import { SR, estimateFrequency, render } from './test-render.ts';

const cell = (song: ReturnType<typeof loadModule>, pattern: number, row: number, channel: number) => {
  const d = (row * song.channels + channel) * 5;
  return Array.from(song.patterns[pattern]!.data.subarray(d, d + 5));
};

describe('MTM loader', () => {
  it('reads tracks, samples and panning', () => {
    const song = loadModule(
      buildMtm({
        samples: [{ data: squareWave(64), volume: 40, finetune: -4, loop: [0, 64] }],
        patterns: [[[{ note: 24, ins: 1, eff: 0xa, param: 0x23 }, { note: 12, ins: 1, eff: 8, param: 0x80 }]]],
        orders: [0],
        pan: [0, 15, 7, 8],
      }),
    );
    expect(song.formatName).toBe('MultiTracker 1.0 MTM');
    expect(song.channels).toBe(4);
    expect(song.channelPanning).toEqual([8, 248, 120, 136]);
    const s = song.instruments[0]!.samples[0]!;
    expect(s.volume).toBe(40);
    // The stored loop end is one past the last looped byte.
    expect(s.loopLength).toBe(63);
    expect(s.relativeNote * 128 + s.finetune).toBe(-64);
    expect(s.usePanning).toBe(false);
    expect(cell(song, 0, 0, 0)).toEqual([49, 1, 0, 0x0a, 0x20]);
    // No 8xx in MultiTracker.
    expect(cell(song, 0, 0, 1)).toEqual([37, 1, 0, 0, 0]);
  });

  it('pairs speed and tempo commands like MultiTracker when they never share a row', () => {
    const song = loadModule(
      buildMtm({
        samples: [],
        patterns: [[[{ eff: 0xf, param: 3 }], [], [{ eff: 0xf, param: 140 }]]],
        orders: [0],
      }),
    );
    expect(cell(song, 0, 0, 1)).toEqual([0, 0, 0, 0x0f, 125]);
    expect(cell(song, 0, 2, 1)).toEqual([0, 0, 0, 0x0f, 6]);
  });
});

describe('669 loader', () => {
  it('reads patterns, break rows and per-pattern speed', () => {
    const song = loadModule(
      build669({
        samples: [{ data: squareWave(32), loop: [0, 32] }, { data: squareWave(16) }],
        patterns: [{ cells: [[{ note: 24, ins: 1, vol: 15 }, { vol: 6 }]], speed: 5, breakRow: 31 }],
        orders: [0],
      }),
    );
    expect(song.formatName).toBe('Composer 669');
    expect(song.channels).toBe(8);
    expect(song.patterns[0]!.rows).toBe(32);
    expect([song.initialSpeed, song.initialTempo]).toEqual([4, 78]);
    // The pattern speed goes into the first free effect slot of row 0.
    expect(cell(song, 0, 0, 0)).toEqual([49, 2, 0x50, 0x0f, 5]);
    expect(cell(song, 0, 0, 1)).toEqual([0, 0, 0x10 + 26, 0, 0]);
    expect(song.instruments[1]!.samples[0]!.loopLength).toBe(0);
  });

  it('keeps a slide going until the next note, by the same number of Hertz per row', () => {
    const song = loadModule(
      build669({
        samples: [{ data: squareWave(32), loop: [0, 32] }],
        patterns: [{ cells: [[{ note: 24, ins: 0, eff: 0, param: 2 }]] }],
        orders: [0],
      }),
    );
    const out = render(song, 2).left;
    const row = (SR * 4 * 2.5) / 78;
    const f = (r: number) => estimateFrequency(out, Math.round(r * row), Math.round((r + 1) * row));
    // 2 * 80 Hz per tick on the sample rate: 20 Hz per row on a 32-sample cycle.
    expect(f(10) - f(2)).toBeGreaterThan(8 * 20 * 0.9);
    expect(f(10) - f(2)).toBeLessThan(8 * 20 * 1.1);
  });
});

describe('OKT loader', () => {
  it('splits channels and maps notes and effects', () => {
    const song = loadModule(
      buildOkt({
        split: [1, 0, 0, 1],
        samples: [{ data: squareWave(64), volume: 20, loop: [0, 64], type: 0 }, { data: squareWave(64), type: 1 }],
        patterns: [
          {
            rows: 16,
            cells: [
              [{ note: 13, ins: 0, eff: 31, param: 0x30 }, undefined, { note: 13, ins: 1, eff: 1, param: 3 }, { note: 13, ins: 0 }],
              [{ eff: 27 }, undefined, { eff: 31, param: 0x20 }, undefined, { note: 13, ins: 1 }],
            ],
          },
        ],
        orders: [0],
        speed: 5,
      }),
    );
    expect(song.format).toBe('mod');
    expect(song.channels).toBe(6);
    expect(song.channelPanning).toEqual([64, 64, 192, 192, 64, 64]);
    expect(song.initialSpeed).toBe(5);
    expect(song.patterns[0]!.rows).toBe(16);
    // Paired voices start at full volume; their volume command sets the hardware channel for both.
    expect(cell(song, 0, 0, 0)).toEqual([49, 1, 0x50, 0x16, 0x30]);
    expect(cell(song, 0, 0, 1)).toEqual([0, 0, 0, 0x16, 0x30]);
    expect(cell(song, 0, 0, 2)).toEqual([49, 2, 0, 0x01, 3]);
    // A type 0 sample on a single channel stays silent.
    expect(cell(song, 0, 0, 3)).toEqual([0, 0, 0, 0, 0]);
    expect(cell(song, 0, 1, 0)).toEqual([NOTE_KEY_OFF, 0, 0, 0, 0]);
    expect(cell(song, 0, 1, 2)).toEqual([0, 0, 0x30, 0, 0]);
    // A type 1 sample on a paired channel stays silent too.
    expect(cell(song, 0, 1, 4)).toEqual([0, 0, 0, 0, 0]);
  });

  it('plays C-3 at the PAL rate', () => {
    const song = loadModule(
      buildOkt({ samples: [{ data: squareWave(32), loop: [0, 32], type: 1 }], patterns: [{ cells: [[{ note: 13, ins: 0 }]] }], orders: [0] }),
    );
    const out = render(song, 0.5, (p) => (p.resampler = 'linear')).left;
    expect(estimateFrequency(out, SR * 0.1, SR * 0.4)).toBeCloseTo(8287 / 32, -1);
  });

  it('converts arpeggios that go below the note by wrapping an octave', () => {
    expect(convertOkt(10, 0x47)).toEqual([0x00, 0x87]);
    expect(convertOkt(11, 0x47)).toEqual([0x00, 0x45]);
    expect(convertOkt(12, 0x47)).toEqual([0x00, 0x47]);
    expect(convertOkt(31, 0x45)).toEqual([0x0a, 0x05]);
    expect(convertOkt(31, 0x63)).toEqual([0x0e, 0xb3]);
    expect(convertOkt(28, 0x40)).toEqual([0, 0]);
  });
});
