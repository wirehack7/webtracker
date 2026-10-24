import { describe, expect, it } from 'vitest';
import {
  copyRange,
  cropRange,
  deleteRange,
  emptySample,
  fadeIn,
  fadeOut,
  generateWave,
  insertFrames,
  normalizeRange,
  resample,
  reverseRange,
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
