import { describe, expect, it } from 'vitest';
import { emptySample, LoopType } from '@webtracker/engine';
import { save8svx } from './iff-write.ts';
import { importSample } from './sample-import.ts';

describe('save8svx', () => {
  it('round-trips data, loop, name and rate through the 8SVX loader', () => {
    const sample = emptySample('snare');
    sample.data = Float32Array.from({ length: 101 }, (_, i) => Math.round(Math.sin(i / 5) * 100) / 128);
    sample.loopType = LoopType.PingPong;
    sample.loopStart = 20;
    sample.loopLength = 60;
    sample.volume = 32;
    const file = save8svx(sample, 16726);
    expect(String.fromCharCode(...file.subarray(0, 4), ...file.subarray(8, 12))).toBe('FORM8SVX');
    expect(file.length % 2).toBe(0);
    const result = importSample(file.slice().buffer, 'x.8svx');
    expect(result?.kind).toBe('sample');
    if (result?.kind !== 'sample') return;
    expect(result.sample.name).toBe('snare');
    expect(result.rate).toBe(16726);
    expect(result.sample.loopType).toBe(LoopType.Forward);
    expect(result.sample.loopStart).toBe(20);
    expect(result.sample.loopLength).toBe(60);
    // The frames after the loop end are not saved.
    expect(result.sample.data.length).toBe(80);
    expect(Array.from(result.sample.data)).toEqual(Array.from(sample.data.subarray(0, 80)));
  });

  it('saves an unlooped sample whole', () => {
    const sample = emptySample();
    sample.data = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const result = importSample(save8svx(sample, 8363).slice().buffer, 'x.iff');
    if (result?.kind !== 'sample') throw new Error('not a sample');
    expect(result.sample.loopType).toBe(LoopType.None);
    expect(Array.from(result.sample.data)).toEqual([0, 0.5, -0.5, 127 / 128, -1]);
  });
});
