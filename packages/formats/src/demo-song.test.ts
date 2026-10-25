import { createDemoSong, renderSong } from '@webtracker/engine';
import { describe, expect, it } from 'vitest';
import { loadXm } from './xm.ts';
import { saveXm } from './xm-write.ts';

describe('demo song', () => {
  const song = createDemoSong();

  it('saves as XM and loads back unchanged', () => {
    const loaded = loadXm(saveXm(song).slice().buffer);
    expect(loaded.title).toBe(song.title);
    expect(loaded.orders).toEqual(song.orders);
    expect(loaded.patterns.map((p) => Array.from(p.data))).toEqual(song.patterns.map((p) => Array.from(p.data)));
    loaded.instruments.forEach((ins, i) => {
      const original = song.instruments[i]!;
      expect(ins.name).toBe(original.name);
      expect(ins.samples.map((s) => Array.from(s.data))).toEqual(original.samples.map((s) => Array.from(s.data)));
    });
  });

  it('plays for about a minute on all four channels without clipping', () => {
    const { left, right, sampleRate } = renderSong(song, { sampleRate: 22050 });
    const seconds = left.length / sampleRate;
    expect(seconds).toBeGreaterThan(55);
    expect(seconds).toBeLessThan(120);
    let peak = 0;
    for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(1);
    for (let ch = 0; ch < song.channels; ch++) {
      expect(song.patterns.some((p) => p.data.some((v, i) => i % 5 === 0 && Math.floor(i / 5) % song.channels === ch && v > 0))).toBe(true);
    }
  });
});
