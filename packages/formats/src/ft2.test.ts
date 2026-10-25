import { describe, expect, it } from 'vitest';
import { loadModule } from './index.ts';
import { buildXm, squareWave, type TestCell, type TestXmInstrument } from './test-builders.ts';
import { SR, estimateFrequency, render, rms } from './test-render.ts';

/**
 * FastTracker 2 quirks of the XM replayer. The expected values were checked
 * against a reference player in FT2 mode.
 */

const C4 = 49;
// Speed 6 at 125 BPM: one tick is 20 ms.
const TICK = SR / 50;

const looped = (extra: Partial<TestXmInstrument> = {}): TestXmInstrument => ({
  samples: [{ data: squareWave(32), loop: 'forward', loopStart: 0, loopLength: 32 }],
  ...extra,
});

function play(cells: (TestCell | undefined)[][], seconds: number, instruments = [looped()], speed = 6) {
  const song = loadModule(buildXm({ channels: 1, orders: [0], speed, patterns: [{ rows: 16, cells }], instruments }));
  return render(song, seconds, (p) => (p.resampler = 'linear'));
}

/** Frequency during tick `t`, skipping the start of the tick. */
const tickFrequency = (signal: Float32Array, t: number) => estimateFrequency(signal, t * TICK + 100, (t + 1) * TICK);

describe('FT2 replayer', () => {
  it('runs arpeggio backwards through the tick counter', () => {
    const { left } = play([[{ note: C4, ins: 1, eff: 0x00, param: 0x47 }]], 0.13);
    const base = 8363 / 32;
    const semis = [1, 2, 3, 4, 5].map((t) => Math.round(12 * Math.log2(tickFrequency(left, t) / base)));
    // At speed 6 FT2 plays base, y, x, base, y, x instead of base, x, y.
    expect(semis).toEqual([7, 4, 0, 7, 4]);
  });

  it('snaps tone portamento to semitones with glissando', () => {
    const cells = [];
    cells[0] = [{ note: C4, ins: 1, eff: 0x0e, param: 0x31 }];
    cells[1] = [{ note: C4 + 12, eff: 0x03, param: 0x08 }];
    const { left } = play(cells, 0.25);
    for (let t = 7; t < 12; t++) {
      const semis = 12 * Math.log2(tickFrequency(left, t) / (8363 / 32));
      expect(Math.abs(semis - Math.round(semis))).toBeLessThan(0.05);
    }
  });

  it('starts the ramp vibrato at zero, rising in period', () => {
    const cells = [];
    cells[0] = [{ note: C4, ins: 1, eff: 0x0e, param: 0x41 }];
    cells[1] = [{ eff: 0x04, param: 0x4f }];
    const { left } = play(cells, 0.25);
    expect(tickFrequency(left, 7)).toBeCloseTo(8363 / 32, 0);
    expect(tickFrequency(left, 10)).toBeLessThan(8363 / 32 - 2);
  });

  it('counts Rxy ticks across rows and from tick 0 of a note with instrument', () => {
    // A click at the sample start, then a quiet loop, so each retrigger shows.
    const click = Int8Array.from({ length: 1200 }, (_, i) => Math.round((i < 30 ? 120 : 10) * Math.sin((2 * Math.PI * i) / 10)));
    const ins = { samples: [{ data: click, loop: 'forward' as const, loopStart: 400, loopLength: 800 }] };
    const cells = [[{ note: C4, ins: 1, eff: 0x1b, param: 0x02 }], [{ eff: 0x1b, param: 0x02 }]];
    const { left } = play(cells, 0.24, [ins]);
    const peak = rms(left, 0, 300);
    const onsets = Array.from({ length: 12 }, (_, t) => (rms(left, t * TICK, t * TICK + 300) > peak / 2 ? 1 : 0));
    expect(onsets.join('')).toBe('110101010101');
  });

  it('restarts the envelope of a delayed note without instrument', () => {
    const ins = looped({ volumeEnvelope: { points: [[0, 64], [4, 64], [8, 0]] } });
    const cells = [];
    cells[0] = [{ note: C4, ins: 1 }];
    cells[4] = [{ note: C4, eff: 0x0e, param: 0xd2 }];
    const { left } = play(cells, 0.6, [ins]);
    expect(rms(left, 20 * TICK, 24 * TICK)).toBe(0);
    expect(rms(left, 26.5 * TICK, 27.5 * TICK)).toBeGreaterThan(0.05);
  });

  it('stops a note whose sample offset is past the end, even when looped', () => {
    const { left } = play([[{ note: C4, ins: 1, eff: 0x09, param: 0x01 }]], 0.1);
    expect(rms(left, 1000)).toBe(0);
  });

  it('keeps the volume of an instrument-only row for the first note on a channel', () => {
    const cells = [];
    // No sample has played yet, so the instrument resets the volume to 0 and
    // the volume column sets it to 16. The note without instrument keeps it.
    cells[0] = [{ ins: 1, vol: 0x20 }];
    cells[2] = [{ note: C4 }];
    const ins = looped();
    ins.samples[0]!.volume = 64;
    const { left } = play(cells, 0.4, [ins]);
    const ref = play([[{ note: C4, ins: 1, vol: 0x20 }]], 0.1, [ins]).left;
    expect(rms(left, 13 * TICK, 15 * TICK)).toBeCloseTo(rms(ref, TICK, 3 * TICK), 2);
  });

  it('plays a ping-pong sample from its start before reaching the loop', () => {
    // First half of the sample one pitch, second half (the loop) an octave up.
    const data = Int8Array.from({ length: 4000 }, (_, i) => (Math.floor(i / (i < 2000 ? 16 : 8)) % 2 ? -100 : 100));
    const ins = { samples: [{ data, loop: 'pingpong' as const, loopStart: 2000, loopLength: 2000 }] };
    const { left } = play([[{ note: C4, ins: 1 }]], 0.2, [ins]);
    expect(estimateFrequency(left, 1000, 5000)).toBeCloseTo(8363 / 32, -1);
  });
  it('never releases a panning envelope that sits on its sustain point at key off', () => {
    const cells = [];
    cells[0] = [{ note: C4, ins: 1 }];
    cells[2] = [{ note: 97 }];
    const song = loadModule(buildXm({ channels: 1, orders: [0], patterns: [{ rows: 16, cells }], instruments: [looped({ volumeEnvelope: { points: [[0, 64], [10, 64]] } })] }));
    // Hard left at tick 2 and held there, then hard right after release.
    song.instruments[0]!.panningEnvelope = { enabled: true, points: [{ x: 0, y: 32 }, { x: 2, y: 0 }, { x: 4, y: 64 }], sustain: true, sustainPoint: 1, loop: false, loopStart: 0, loopEnd: 0 };
    const { left, right } = render(song, 0.6, (p) => (p.resampler = 'linear'));
    expect(rms(left, 20 * TICK, 25 * TICK)).toBeGreaterThan(0.05);
    expect(rms(right, 20 * TICK, 25 * TICK)).toBeLessThan(0.001);
  });

  it('keeps the fadeout of the old instrument when a note switches instruments after key off', () => {
    const env = { points: [[0, 64], [10, 64]] as [number, number][] };
    const cells = [];
    cells[0] = [{ note: C4, ins: 2 }];
    cells[1] = [{ note: 97, ins: 1 }];
    cells[2] = [{ note: C4 }];
    // Instrument 1 never fades out by itself, instrument 2 is gone in 8 ticks.
    const instruments = [looped({ volumeEnvelope: env }), looped({ volumeEnvelope: env, fadeout: 4096 })];
    const { left } = play(cells, 0.6, instruments);
    expect(rms(left, 16 * TICK, 18 * TICK)).toBe(0);
  });
});
