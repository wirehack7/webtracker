import { describe, expect, it } from 'vitest';
import { loadModule } from './index.ts';
import { NOTE_KEY_OFF } from '@webtracker/engine';
import { buildXm, squareWave, type TestXmInstrument } from './test-builders.ts';
import { SR, estimateFrequency, render, rms } from './test-render.ts';

const C4 = 49;
const C5 = 61;

function square16(length: number): Int16Array {
  const d = new Int16Array(length);
  for (let i = 0; i < length; i++) d[i] = i < length / 2 ? 20000 : -20000;
  return d;
}

const loopedInstrument = (extra: Partial<TestXmInstrument> = {}): TestXmInstrument => ({
  samples: [{ data: squareWave(32), loop: 'forward', loopStart: 0, loopLength: 32 }],
  ...extra,
});

describe('XM loader', () => {
  it('reads header, packed patterns and delta-encoded samples', () => {
    const song = loadModule(
      buildXm({
        title: 'xm test',
        channels: 6,
        orders: [0, 1, 0],
        restart: 1,
        speed: 4,
        tempo: 140,
        patterns: [
          { rows: 32, cells: [[{ note: C5, ins: 1, vol: 0x30, eff: 0x0f, param: 0x05 }]] },
          { rows: 16, cells: [] },
        ],
        instruments: [{ samples: [{ data: square16(64), relativeNote: -12, finetune: -16, loop: 'pingpong', loopStart: 8, loopLength: 16 }] }],
      }),
    );
    expect(song.format).toBe('xm');
    expect(song.title).toBe('xm test');
    expect(song.channels).toBe(6);
    expect(song.orders).toEqual([0, 1, 0]);
    expect(song.restartPosition).toBe(1);
    expect(song.initialSpeed).toBe(4);
    expect(song.initialTempo).toBe(140);
    expect(song.linearFrequency).toBe(true);
    expect(song.patterns.map((p) => p.rows)).toEqual([32, 16]);
    expect(Array.from(song.patterns[0]!.data.subarray(0, 5))).toEqual([C5, 1, 0x30, 0x0f, 0x05]);
    const s = song.instruments[0]!.samples[0]!;
    expect(s.data).toHaveLength(64);
    expect(s.data[0]).toBeCloseTo(20000 / 32768);
    expect(s.data[40]).toBeCloseTo(-20000 / 32768);
    expect(s.relativeNote).toBe(-12);
    expect(s.finetune).toBe(-16);
    expect(s.loopType).toBe(2);
    expect(s.loopStart).toBe(8);
    expect(s.loopLength).toBe(16);
  });
});

describe('XM playback', () => {
  it('plays C-4 at 8363 Hz with linear frequencies', () => {
    const song = loadModule(
      buildXm({ channels: 2, orders: [0], patterns: [{ rows: 64, cells: [[{ note: C4, ins: 1 }]] }], instruments: [loopedInstrument()] }),
    );
    const { left } = render(song, 0.5);
    expect(estimateFrequency(left, SR * 0.05)).toBeCloseTo(8363 / 32, 0);
  });

  it('applies relative note and Amiga frequency mode', () => {
    const ins = loopedInstrument();
    ins.samples[0]!.relativeNote = 12;
    for (const linear of [true, false]) {
      const song = loadModule(
        buildXm({ channels: 2, linear, orders: [0], patterns: [{ rows: 64, cells: [[{ note: C4, ins: 1 }]] }], instruments: [ins] }),
      );
      const { left } = render(song, 0.5);
      expect(estimateFrequency(left, SR * 0.05)).toBeCloseTo((2 * 8363) / 32, -1);
    }
  });

  it('cuts notes on key off without a volume envelope', () => {
    const song = loadModule(
      buildXm({
        channels: 2,
        orders: [0],
        patterns: [{ rows: 64, cells: [[{ note: C4, ins: 1 }], [{ note: NOTE_KEY_OFF }]] }],
        instruments: [loopedInstrument()],
      }),
    );
    const { left } = render(song, 0.5);
    expect(rms(left, 0, 4000)).toBeGreaterThan(0.1);
    expect(rms(left, SR * 0.3)).toBe(0);
  });

  it('holds the envelope sustain point and fades out after key off', () => {
    const ins = loopedInstrument({
      volumeEnvelope: { points: [[0, 64], [10, 32]], sustain: 1 },
      fadeout: 4096,
    });
    const cells = [];
    cells[0] = [{ note: C4, ins: 1 }];
    cells[16] = [{ note: NOTE_KEY_OFF }];
    const song = loadModule(buildXm({ channels: 2, orders: [0], patterns: [{ rows: 64, cells }], instruments: [ins] }));
    const { left } = render(song, 3.0);
    const start = rms(left, 300, 800); // first tick, after the initial ramp
    const sustained = rms(left, SR * 1.0, SR * 1.5);
    expect(sustained / start).toBeCloseTo(0.5, 1);
    // Fadeout of 4096/32768 per tick silences the note within 8 ticks after row 16.
    expect(rms(left, SR * 2.5)).toBe(0);
  });

  it('plays the volume column and E6x pattern loops', () => {
    const cells = [];
    cells[0] = [{ note: C4, ins: 1, vol: 0x10 + 32, eff: 0x0e, param: 0x60 }];
    cells[1] = [{ eff: 0x0e, param: 0x62 }];
    cells[2] = [{ eff: 0x0f, param: 1 }];
    const song = loadModule(buildXm({ channels: 1, orders: [0], patterns: [{ rows: 4, cells }], instruments: [loopedInstrument()] }));
    const { rows } = render(song, 1.0);
    expect(rows.slice(0, 7).map((r) => r.row)).toEqual([0, 1, 0, 1, 0, 1, 2]);
  });

  it('delays notes with EDx', () => {
    const song = loadModule(
      buildXm({
        channels: 1,
        orders: [0],
        tempo: 125,
        patterns: [{ rows: 64, cells: [[{ note: C4, ins: 1, eff: 0x0e, param: 0xd3 }]] }],
        instruments: [loopedInstrument()],
      }),
    );
    const { left } = render(song, 0.3);
    const tick = (SR * 2.5) / 125;
    expect(rms(left, 0, Math.floor(tick * 3) - 10)).toBe(0);
    expect(rms(left, Math.ceil(tick * 3) + 200, Math.ceil(tick * 5))).toBeGreaterThan(0.1);
  });
});
