import { describe, expect, it } from 'vitest';
import { NOTE_KEY_OFF } from '@webtracker/engine';
import { loadModule } from './index.ts';
import { convertEffect, convertVolume, decompressIt } from './it.ts';
import { buildIt, compressIt, squareWave } from './test-builders.ts';
import { SR, estimateFrequency, render } from './test-render.ts';

const C5 = 60; // IT middle C

function noise8(n: number): Int8Array {
  let seed = 1;
  return Int8Array.from({ length: n }, (_, i) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Mix smooth and jumpy stretches so every bit width shows up.
    return i % 3000 < 1500 ? Math.round(Math.sin(i / 20) * 100) : (seed >> 16) & 0xff;
  });
}

describe('IT sample decompression', () => {
  for (const it215 of [false, true]) {
    it(`restores 8-bit data (${it215 ? '2.15' : '2.14'})`, () => {
      const data = noise8(40000); // spans two blocks
      const packed = compressIt(data, it215);
      const out = decompressIt(packed, 0, data.length, false, it215);
      expect(Array.from(out, (v) => Math.round(v * 128))).toEqual(Array.from(data));
    });

    it(`restores 16-bit data (${it215 ? '2.15' : '2.14'})`, () => {
      const data = Int16Array.from(noise8(20000), (v, i) => v * 200 + (i % 7) * 13 - (i % 5) * 300);
      const packed = compressIt(data, it215);
      const out = decompressIt(packed, 0, data.length, true, it215);
      expect(Array.from(out, (v) => Math.round(v * 32768))).toEqual(Array.from(data));
    });
  }
});

describe('IT loader', () => {
  it('reads a sample-mode song', () => {
    const song = loadModule(
      buildIt({
        title: 'impulse',
        samples: [{ data: squareWave(64), volume: 40, globalVolume: 32, loop: [0, 64], pingpong: true }],
        patterns: [
          { rows: 32, cells: [[{ note: C5, ins: 1, vol: 20, cmd: 'A', info: 4 }, undefined, { note: 255 }]] },
          { cells: [] },
        ],
        orders: [1, 254, 0, 255, 1],
        linear: true,
        channelPan: [0, 64, 32],
        globalVolume: 64,
        speed: 4,
        tempo: 140,
      }),
    );
    expect(song.formatName).toBe('Impulse Tracker 2.14 IT');
    expect(song.title).toBe('impulse');
    expect(song.linearFrequency).toBe(true);
    expect(song.channels).toBe(3);
    expect(song.orders).toEqual([1, 0]);
    expect(song.patterns[0]!.rows).toBe(32);
    expect([song.initialSpeed, song.initialTempo, song.initialGlobalVolume]).toEqual([4, 140, 32]);
    expect(song.channelPanning).toEqual([0, 255, 128]);
    const s = song.instruments[0]!.samples[0]!;
    expect(s.volume).toBe(40);
    expect(s.loopType).toBe(2);
    expect(s.usePanning).toBe(false);
    // Sample global volume 32 halves the data.
    expect(s.data[0]).toBeCloseTo(50 / 128);
    const d = song.patterns[0]!.data;
    expect(Array.from(d.subarray(0, 5))).toEqual([49, 1, 0x10 + 20, 0x0f, 4]);
    expect(d[10]).toBe(NOTE_KEY_OFF);
  });

  it('maps instruments, keyboard and envelopes', () => {
    const keyboard = Array.from({ length: 120 }, (_, n) => (n < C5 ? 1 : 2));
    const song = loadModule(
      buildIt({
        samples: [{ data: squareWave(32) }, { data: squareWave(16), pan: 16 }],
        instruments: [
          {
            name: 'split',
            keyboard,
            fadeout: 64,
            volumeEnvelope: { points: [[0, 64], [10, 32], [20, 0]], sustain: 1, loop: [0, 1] },
            panningEnvelope: { points: [[0, 0xe0], [8, 32]] },
          },
          { keyboard: 1 },
        ],
        patterns: [{ cells: [[{ note: C5, ins: 1 }]] }],
        orders: [0],
      }),
    );
    const [split, plain] = song.instruments;
    expect(split!.name).toBe('split');
    expect(split!.samples).toHaveLength(2);
    expect(split!.keymap[C5 - 12 - 1]).toBe(0);
    expect(split!.keymap[C5 - 12]).toBe(1);
    expect(split!.fadeout).toBe(64 * 32);
    const ve = split!.volumeEnvelope;
    expect(ve.points).toEqual([
      { x: 0, y: 64 },
      { x: 10, y: 32 },
      { x: 20, y: 0 },
    ]);
    expect([ve.sustain, ve.sustainPoint, ve.loop, ve.loopStart, ve.loopEnd]).toEqual([true, 1, true, 0, 1]);
    expect(split!.panningEnvelope.points).toEqual([
      { x: 0, y: 0 },
      { x: 8, y: 64 },
    ]);
    expect(split!.samples[1]!.usePanning).toBe(true);
    expect(split!.samples[1]!.panning).toBe(64);
    // Without an envelope a held one keeps key off from cutting the note, as in IT.
    expect(plain!.volumeEnvelope.enabled).toBe(true);
    expect(plain!.volumeEnvelope.sustain).toBe(true);
  });

  it('plays C-5 at the sample C5Speed', () => {
    const song = loadModule(
      buildIt({
        samples: [{ data: squareWave(32), c5speed: 16726, loop: [0, 32] }],
        patterns: [{ cells: [[{ note: C5, ins: 1 }]] }],
        orders: [0],
      }),
    );
    const out = render(song, 0.5).left;
    expect(estimateFrequency(out, SR * 0.1, SR * 0.4)).toBeCloseTo(16726 / 32, -1);
  });

  it('starts the fadeout once a released envelope has ended', () => {
    const song = loadModule(
      buildIt({
        samples: [{ data: squareWave(32), loop: [0, 32] }],
        instruments: [{ keyboard: 1, fadeout: 32, volumeEnvelope: { points: [[0, 64], [10, 64], [20, 32]], sustain: 1 } }],
        patterns: [{ cells: [[{ note: C5, ins: 1 }], [], [], [], [{ note: 255 }]] }],
        orders: [0],
      }),
    );
    const out = render(song, 2).left;
    const tick = SR * 0.02;
    const level = (t: number) => Math.max(...Array.from(out.subarray(Math.round(t * tick), Math.round((t + 1) * tick)), Math.abs));
    // Key off at tick 24: the release takes 10 ticks to the end point (half volume), then 32 ticks of fadeout.
    const near = (value: number, target: number) => expect(Math.abs(value - target)).toBeLessThan(0.1);
    near(level(34) / level(20), 0.5);
    near(level(50) / level(34), 0.5);
    expect(level(70)).toBe(0);
  });

  it('applies channel volume (Mxx) on top of the note volume', () => {
    const song = (cmd?: string) =>
      loadModule(
        buildIt({
          samples: [{ data: squareWave(32), loop: [0, 32] }],
          patterns: [{ cells: [[cmd ? { note: C5, ins: 1, cmd, info: 0x20 } : { note: C5, ins: 1 }]] }],
          orders: [0],
        }),
      );
    const level = (s: ReturnType<typeof loadModule>) => Math.max(...Array.from(render(s, 0.3).left.subarray(SR * 0.1), Math.abs));
    expect(level(song('M')) / level(song())).toBeCloseTo(0.5, 2);
  });

  it('plays compressed samples', () => {
    const data = squareWave(32);
    const song = loadModule(
      buildIt({
        samples: [{ data, compressed: 'it215', loop: [0, 32] }],
        patterns: [{ cells: [[{ note: C5, ins: 1 }]] }],
        orders: [0],
      }),
    );
    expect(Array.from(song.instruments[0]!.samples[0]!.data, (v) => v * 128)).toEqual(Array.from(data));
  });

  it('turns note cut into a zero volume', () => {
    const song = loadModule(
      buildIt({ samples: [], patterns: [{ cells: [[{ note: 254 }]] }], orders: [0] }),
    );
    expect(Array.from(song.patterns[0]!.data.subarray(0, 5))).toEqual([0, 0, 0x10, 0, 0]);
  });

  it('converts commands and the volume column', () => {
    const c = (letter: string, info: number) => convertEffect(letter.charCodeAt(0) - 64, info);
    expect(c('C', 0x10)).toEqual([0x0d, 0x16]);
    expect(c('P', 0x04)).toEqual([0x19, 0x40]);
    expect(c('V', 0x80)).toEqual([0x10, 64]);
    expect(c('W', 0x20)).toEqual([0x11, 0x10]);
    expect(c('W', 0x03)).toEqual([0x11, 0x02]);
    expect(c('X', 0xff)).toEqual([0x08, 0xff]);
    expect(c('S', 0x91)).toEqual([0, 0]);
    expect(c('S', 0xd2)).toEqual([0x0e, 0xd2]);
    expect(c('D', 0xf2)).toEqual([0x0e, 0xb2]);
    expect(c('M', 0x20)).toEqual([0x16, 0x20]);
    expect(c('N', 0x0f)).toEqual([0x17, 0x0f]);
    expect(convertVolume(64)).toEqual({ volume: 0x50 });
    expect(convertVolume(67)).toEqual({ volume: 0x92 });
    expect(convertVolume(80)).toEqual({ volume: 0x85 });
    expect(convertVolume(90)).toEqual({ volume: 0x75 });
    expect(convertVolume(100)).toEqual({ volume: 0x65 });
    expect(convertVolume(108)).toEqual({ volume: 0, effect: [0x02, 12] });
    expect(convertVolume(192)).toEqual({ volume: 0xcf });
    expect(convertVolume(196)).toEqual({ volume: 0xf1, effect: [0x03, 8] });
    expect(convertVolume(205)).toEqual({ volume: 0xb1 });
    expect(convertVolume(205, true)).toEqual({ volume: 0xb2 });
    expect(c('H', 0x46)).toEqual([0x04, 0x43]);
    expect(convertEffect(8, 0x46, true)).toEqual([0x04, 0x46]);
  });
});
