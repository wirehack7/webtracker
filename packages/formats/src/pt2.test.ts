import { describe, expect, it } from 'vitest';
import { loadModule } from './index.ts';
import { buildMod, type TestPattern } from './test-builders.ts';
import { SR, estimateFrequency, render, rms } from './test-render.ts';

/**
 * ProTracker 2 quirks of the MOD replayer. The expected behaviour follows
 * ProTracker's replay routine and Paula's sample DMA.
 */

const C4 = 49;
// Period 428 at the PAL clock.
const RATE = 3546895 / 428;
// Speed 6 at 125 BPM: one row is 120 ms.
const ROW = 0.12;

/** `length` frames of a square wave with the given period in frames. */
const square = (length: number, period: number) =>
  Int8Array.from({ length }, (_, i) => (i % period < period / 2 ? 100 : -100));

function play(pattern: TestPattern, samples: Parameters<typeof buildMod>[0]['samples'], seconds: number, extra = {}) {
  const song = loadModule(buildMod({ samples, patterns: [pattern], orders: [0], ...extra }), 'test.mod');
  return render(song, seconds, (p) => (p.resampler = 'linear'));
}

const at = (signal: Float32Array, from: number, to: number) => estimateFrequency(signal, Math.round(from * SR), Math.round(to * SR));

describe('ProTracker replayer', () => {
  it('swaps to a new sample at the end of the current loop, with its volume at once', () => {
    const cells = [];
    cells[0] = [{ note: C4, ins: 1 }];
    cells[1] = [{ ins: 2 }];
    const samples = [
      // A long first run, then a short loop at its end.
      { data: square(4000, 32), volume: 64, loopStart: 3968, loopLength: 32 },
      { data: square(64, 64), volume: 32, loopStart: 0, loopLength: 64 },
    ];
    const { left } = play(cells, samples, 0.8);
    expect(at(left, 0.15, 0.4)).toBeCloseTo(RATE / 32, -1);
    expect(rms(left, 0.15 * SR, 0.4 * SR)).toBeCloseTo(rms(left, 0.02 * SR, 0.1 * SR) / 2, 2);
    expect(at(left, 0.55, 0.8)).toBeCloseTo(RATE / 64, -1);
  });

  it('swaps a stopped one-shot sample to a looped one without a note', () => {
    const cells = [];
    cells[0] = [{ note: C4, ins: 1 }];
    cells[3] = [{ ins: 2 }];
    const samples = [{ data: square(256, 32), volume: 64 }, { data: square(64, 64), volume: 64, loopStart: 0, loopLength: 64 }];
    const { left } = play(cells, samples, 0.6);
    expect(rms(left, 0.1 * SR, 0.35 * SR)).toBe(0);
    expect(at(left, 0.4, 0.6)).toBeCloseTo(RATE / 64, -1);
  });

  it('adds a sample offset twice for the next note without instrument', () => {
    const data = Int8Array.from([...square(1024, 32), ...square(1024, 16), ...square(4000, 64)]);
    const cells = [];
    cells[0] = [{ note: C4, ins: 1, eff: 0x09, param: 0x04 }];
    cells[2] = [{ note: C4 }];
    const { left } = play(cells, [{ data, volume: 64 }], 0.4);
    expect(at(left, 0.01, 0.1)).toBeCloseTo(RATE / 16, -1);
    expect(at(left, 2 * ROW + 0.01, 2 * ROW + 0.1)).toBeCloseTo(RATE / 64, -1);
  });

  it('skips the target row of a pattern break on a row with pattern delay', () => {
    const song = loadModule(
      buildMod({
        samples: [],
        patterns: [[[{ eff: 0x0d, param: 0x01 }, { eff: 0x0e, param: 0xe1 }]], []],
        orders: [0, 1],
      }),
      'test.mod',
    );
    const { rows } = render(song, 0.5);
    expect(rows.slice(0, 2).map((s) => [s.order, s.row])).toEqual([
      [0, 0],
      [1, 2],
    ]);
  });

  it('keeps the old target of an unfinished tone portamento after a new note', () => {
    const cells = [];
    cells[0] = [{ note: C4, ins: 1 }];
    // Slides only a little way towards C-5 ...
    cells[1] = [{ note: C4 + 12, eff: 0x03, param: 0x01 }];
    // ... then a new note, and a portamento without note still heads for C-5.
    cells[2] = [{ note: C4 - 12 }];
    cells[3] = [{ eff: 0x03, param: 0xff }];
    const { left } = play(cells, [{ data: square(64, 32), volume: 64, loopStart: 0, loopLength: 64 }], 0.6);
    expect(at(left, 3 * ROW + 0.07, 4 * ROW)).toBeCloseTo((2 * RATE) / 32, -1);
  });
});
