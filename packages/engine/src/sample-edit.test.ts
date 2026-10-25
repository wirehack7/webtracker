import { describe, expect, it } from 'vitest';
import {
  drawLine,
  gainRange,
  copyRange,
  crossfadeLoop,
  cropRange,
  deleteRange,
  emptySample,
  fadeIn,
  fadeOut,
  filterRange,
  generateWave,
  insertFrames,
  invertRange,
  normalizeRange,
  quantize8,
  rateForTuning,
  removeDcRange,
  resample,
  reverseRange,
  swapBytesRange,
  toggleSignRange,
  tuningForRate,
} from './sample-edit.ts';
import { LoopType, type Sample } from './song.ts';

function ramp(n: number, loop?: [number, number]): Sample {
  const s = emptySample('t');
  s.data = Float32Array.from({ length: n }, (_, i) => i / n);
  if (loop) {
    s.loopType = LoopType.Forward;
    s.loopStart = loop[0];
    s.loopLength = loop[1];
  }
  return s;
}

describe('range edits', () => {
  it('deletes a range and moves the loop with it', () => {
    const s = ramp(100, [60, 20]);
    deleteRange(s, { start: 10, end: 30 });
    expect(s.data.length).toBe(80);
    expect(s.data[10]).toBeCloseTo(0.3);
    expect([s.loopStart, s.loopLength]).toEqual([40, 20]);
  });

  it('switches the loop off when it is deleted', () => {
    const s = ramp(100, [60, 20]);
    deleteRange(s, { start: 50, end: 100 });
    expect(s.loopType).toBe(LoopType.None);
    expect(s.loopLength).toBe(0);
  });

  it('crops to a range', () => {
    const s = ramp(100, [60, 20]);
    cropRange(s, { start: 50, end: 90 });
    expect(s.data.length).toBe(40);
    expect(s.data[0]).toBeCloseTo(0.5);
    expect([s.loopStart, s.loopLength]).toEqual([10, 20]);
  });

  it('inserts copied frames', () => {
    const s = ramp(10, [5, 5]);
    const copied = copyRange(s, { start: 0, end: 2 });
    insertFrames(s, 2, copied);
    expect(s.data.length).toBe(12);
    expect(s.data[2]).toBe(0);
    expect([s.loopStart, s.loopLength]).toEqual([7, 5]);
  });

  it('reverses, normalizes and fades', () => {
    const s = ramp(4);
    reverseRange(s, { start: 0, end: 4 });
    expect(Array.from(s.data)).toEqual([0.75, 0.5, 0.25, 0]);
    normalizeRange(s, { start: 0, end: 4 });
    expect(s.data[0]).toBeCloseTo(1);
    fadeOut(s, { start: 0, end: 4 });
    expect(s.data[3]).toBe(0);
    fadeIn(s, { start: 0, end: 4 });
    expect(s.data[0]).toBe(0);
  });
});

describe('tuning and resampling', () => {
  it('tunes 8363 Hz to no offset and 16726 Hz to one octave up', () => {
    expect(tuningForRate(8363)).toEqual({ relativeNote: 0, finetune: 0 });
    expect(tuningForRate(16726)).toEqual({ relativeNote: 12, finetune: 0 });
    const t = tuningForRate(44100);
    expect(t.relativeNote * 128 + t.finetune).toBeCloseTo(12 * Math.log2(44100 / 8363) * 128, -1);
  });

  it('resamples to twice the length and keeps the pitch', () => {
    const s = ramp(50, [10, 20]);
    resample(s, 2);
    expect(s.data.length).toBe(100);
    expect([s.loopStart, s.loopLength]).toEqual([20, 40]);
    expect(s.relativeNote).toBe(12);
    expect(s.finetune).toBe(0);
  });
});

describe('generateWave', () => {
  it('makes 8-bit exact chip waves', () => {
    for (const shape of ['square', 'pulse25', 'triangle', 'saw', 'sine', 'noise'] as const) {
      const w = generateWave(shape, 32);
      expect(w.length).toBe(32);
      for (const v of w) expect(v * 128).toBe(Math.round(v * 128));
    }
    expect(generateWave('pulse25', 32).filter((v) => v > 0).length).toBe(8);
  });

  it('makes the same noise for the same seed', () => {
    expect(Array.from(generateWave('noise', 64, 7))).toEqual(Array.from(generateWave('noise', 64, 7)));
  });
});

describe('sample tools', () => {
  const all = (s: Sample) => ({ start: 0, end: s.data.length });

  it('inverts, flips the sign bit and swaps bytes', () => {
    const s = emptySample();
    s.data = Float32Array.from([0.5, -0.25, 0]);
    invertRange(s, all(s));
    expect(Array.from(s.data)).toEqual([-0.5, 0.25, -0]);
    // An unsigned 8-bit 0x80 (silence) read as signed is -128; flipping the sign bit gives 0.
    s.data = Float32Array.from([-1, 0]);
    toggleSignRange(s, all(s));
    expect(Array.from(s.data)).toEqual([0, -1]);
    s.data = Float32Array.from([0x0100 / 32768]);
    swapBytesRange(s, all(s));
    expect(s.data[0]).toBeCloseTo(1 / 32768, 8);
  });

  it('removes the DC offset and rounds to 8 bits', () => {
    const s = emptySample();
    s.data = Float32Array.from([0.6, 0.4, 0.6, 0.4]);
    removeDcRange(s, all(s));
    expect(s.data.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    s.data = Float32Array.from([0.1234]);
    quantize8(s);
    expect(s.data[0]! * 128).toBe(16);
  });

  it('low-pass smooths and high-pass removes a constant', () => {
    const s = emptySample();
    s.data = Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 1 : -1));
    filterRange(s, all(s), 'lowpass', 500, 8363);
    expect(Math.max(...s.data.subarray(32).map(Math.abs))).toBeLessThan(0.5);
    s.data = new Float32Array(256).fill(0.5);
    filterRange(s, all(s), 'highpass', 500, 8363);
    expect(Math.abs(s.data[255]!)).toBeLessThan(0.01);
  });

  it('crossfades the loop end into the frames before the loop start', () => {
    const s = ramp(100, [40, 40]);
    expect(crossfadeLoop(s, 10)).toBe(10);
    // The last loop frame now leads smoothly into the loop start.
    expect(s.data[79]).toBeCloseTo(s.data[39]!, 1);
    expect(crossfadeLoop(ramp(10), 4)).toBe(0);
  });

  it('works out the C-4 rate from the tuning', () => {
    expect(rateForTuning(0, 0)).toBeCloseTo(8363);
    const t = tuningForRate(44100);
    expect(rateForTuning(t.relativeNote, t.finetune)).toBeCloseTo(44100, -2);
  });
});

describe('gainRange', () => {
  it('ramps the gain across the range and clips', () => {
    const s = { data: new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5]) } as Sample;
    gainRange(s, { start: 0, end: 5 }, 1, 0);
    expect(Array.from(s.data)).toEqual([0.5, 0.375, 0.25, 0.125, 0]);
    gainRange(s, { start: 0, end: 1 }, 4, 4);
    expect(s.data[0]).toBe(1);
  });
});

describe('drawLine', () => {
  it('draws a straight line in either direction and stays inside the sample', () => {
    const s = { data: new Float32Array(5) } as Sample;
    drawLine(s, 4, 1, 0, -1);
    expect(Array.from(s.data)).toEqual([-1, -0.5, 0, 0.5, 1]);
    drawLine(s, -3, 2, 1, 2);
    expect(Array.from(s.data)).toEqual([1, 1, 0, 0.5, 1]);
    drawLine(s, 9, 0, 9, 0);
    expect(s.data.length).toBe(5);
  });
});
