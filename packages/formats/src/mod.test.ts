import { describe, expect, it } from 'vitest';
import { loadModule } from './index.ts';
import { buildMod, squareWave, type TestPattern } from './test-builders.ts';
import { SR, estimateFrequency, render, rms } from './test-render.ts';

const C4 = 49;

function modWith(pattern: TestPattern, extra: Partial<Parameters<typeof buildMod>[0]> = {}) {
  return loadModule(
    buildMod({
      samples: [{ data: squareWave(32), volume: 64, loopStart: 0, loopLength: 32 }],
      patterns: [pattern],
      orders: [0],
      ...extra,
    }),
    'test.mod',
  );
}

describe('MOD loader', () => {
  it('reads header, samples and patterns', () => {
    const song = modWith([[{ note: C4, ins: 1, eff: 0x0c, param: 0x20 }]], { title: 'hello' });
    expect(song.format).toBe('mod');
    expect(song.title).toBe('hello');
    expect(song.channels).toBe(4);
    expect(song.orders).toEqual([0]);
    expect(song.patterns).toHaveLength(1);
    expect(song.instruments).toHaveLength(31);
    const s = song.instruments[0]!.samples[0]!;
    expect(s.data).toHaveLength(32);
    expect(s.loopLength).toBe(32);
    expect(s.data[0]).toBeCloseTo(100 / 128);
    const d = song.patterns[0]!.data;
    expect(Array.from(d.subarray(0, 5))).toEqual([C4, 1, 0, 0x0c, 0x20]);
    expect(song.channelPanning).toEqual([64, 192, 192, 64]);
  });

  it('detects multichannel tags', () => {
    const song = loadModule(buildMod({ samples: [], patterns: [[]], orders: [0], channels: 8 }));
    expect(song.channels).toBe(8);
  });
});

describe('MOD playback', () => {
  it('plays C-4 at the PAL Amiga rate', () => {
    const song = modWith([[{ note: C4, ins: 1 }]]);
    const { left } = render(song, 0.5);
    // 32-sample cycle at period 428 of the PAL clock, about 8287 Hz.
    expect(estimateFrequency(left, SR * 0.05)).toBeCloseTo(3546895 / 428 / 32, 0);
  });

  it('plays an octave higher one octave up', () => {
    const song = modWith([[{ note: C4 + 12, ins: 1 }]]);
    const { left } = render(song, 0.5);
    expect(estimateFrequency(left, SR * 0.05)).toBeCloseTo((2 * 8363) / 32, -1);
  });

  it('advances rows at speed 6 / 125 BPM', () => {
    const song = modWith([[{ note: C4, ins: 1 }]]);
    const { rows } = render(song, 1.0);
    // 125 BPM => 50 ticks/s => 8.33 rows/s at speed 6.
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.length).toBeLessThanOrEqual(9);
  });

  it('honours Fxx speed and tempo', () => {
    const song = modWith([[{ eff: 0x0f, param: 3 }, { eff: 0x0f, param: 250 }]]);
    const { rows, player } = render(song, 1.0);
    expect(player.speed).toBe(3);
    expect(player.tempo).toBe(250);
    // 100 ticks/s at speed 3 => ~33 rows/s.
    expect(rows.length).toBeGreaterThanOrEqual(32);
    expect(rows.length).toBeLessThanOrEqual(34);
  });

  it('applies Cxx volume and A0x slide to silence', () => {
    const loud = render(modWith([[{ note: C4, ins: 1 }]]), 0.3).left;
    const quiet = render(modWith([[{ note: C4, ins: 1, eff: 0x0c, param: 16 }]]), 0.3).left;
    expect(rms(quiet, 4000) / rms(loud, 4000)).toBeCloseTo(0.25, 1);

    const pattern: TestPattern = [[{ note: C4, ins: 1, eff: 0x0a, param: 0x0f }]];
    for (let r = 1; r < 8; r++) pattern[r] = [{ eff: 0x0a, param: 0x0f }];
    const { left } = render(modWith(pattern), 1.0);
    expect(rms(left, SR * 0.8)).toBe(0);
  });

  it('jumps with Bxx and breaks with Dxx', () => {
    const song = loadModule(
      buildMod({
        samples: [{ data: squareWave(32) }],
        patterns: [[[{ eff: 0x0d, param: 0x10 }]], [], []],
        orders: [0, 2, 1],
      }),
    );
    // Pattern 0 breaks on row 0 to row 10 of the next order.
    const { rows } = render(song, 0.3);
    expect(rows[0]).toMatchObject({ order: 0, row: 0 });
    expect(rows[1]).toMatchObject({ order: 1, pattern: 2, row: 10 });
  });

  it('wraps to the restart position at the end of the song', () => {
    const pattern: TestPattern = [];
    pattern[0] = [{ eff: 0x0f, param: 1 }];
    pattern[1] = [{ eff: 0x0b, param: 0 }];
    const { player } = render(modWith(pattern), 0.5);
    expect(player.loops).toBeGreaterThan(0);
    expect(player.order).toBe(0);
  });

  it('slides towards the target note with tone portamento', () => {
    const pattern: TestPattern = [[{ note: C4, ins: 1 }], [{ note: C4 + 12, eff: 0x03, param: 0xff }]];
    const { left } = render(modWith(pattern), 0.8);
    expect(estimateFrequency(left, SR * 0.5)).toBeCloseTo((2 * 8363) / 32, -1);
  });
});
