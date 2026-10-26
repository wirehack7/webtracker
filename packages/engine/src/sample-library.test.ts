import { describe, expect, it } from 'vitest';
import { LIBRARY_CATEGORIES, librarySound, SAMPLE_LIBRARY } from './sample-library.ts';
import { LoopType } from './song.ts';

describe('sample library', () => {
  it('has unique ids and names that fit XM', () => {
    expect(new Set(SAMPLE_LIBRARY.map((s) => s.id)).size).toBe(SAMPLE_LIBRARY.length);
    for (const sound of SAMPLE_LIBRARY) {
      expect(sound.name.length).toBeLessThanOrEqual(22);
      expect(librarySound(sound.id)).toBe(sound);
    }
  });

  it('fills every category', () => {
    for (const category of LIBRARY_CATEGORIES) expect(SAMPLE_LIBRARY.filter((s) => s.category === category).length).toBeGreaterThan(3);
  });

  it.each(SAMPLE_LIBRARY.map((s) => [s.id, s] as const))('%s makes a valid, audible 8-bit sample', (_, sound) => {
    const ins = sound.make();
    expect(ins.name).toBe(sound.name);
    expect(ins.samples).toHaveLength(1);
    const s = ins.samples[0]!;
    expect(s.data.length).toBeGreaterThan(16);
    let peak = 0;
    for (const v of s.data) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      // On the 8-bit grid, so saving as 8-bit changes nothing.
      expect(Math.round(v * 128)).toBeCloseTo(v * 128, 6);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.2);
    if (sound.category === 'chip') {
      expect(s.loopType).toBe(LoopType.Forward);
      expect(s.loopStart + s.loopLength).toBe(s.data.length);
    } else {
      expect(s.loopType).toBe(LoopType.None);
      // Drums are made at twice 8363 Hz, so C-4 plays them as made.
      expect([s.relativeNote, s.finetune]).toEqual([12, 0]);
      expect(s.data[s.data.length - 1]!).toBeCloseTo(0, 0);
    }
  });

  it('makes the same sound every time', () => {
    for (const sound of SAMPLE_LIBRARY) expect(sound.make().samples[0]!.data).toEqual(sound.make().samples[0]!.data);
  });
});
