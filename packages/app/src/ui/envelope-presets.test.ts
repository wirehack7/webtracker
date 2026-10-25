import { describe, expect, it } from 'vitest';
import { copyEnvelope, PANNING_PRESETS, pastedEnvelope, VOLUME_PRESETS } from './envelope-presets.ts';

describe('envelope presets', () => {
  it('are valid FT2 envelopes', () => {
    for (const preset of [...VOLUME_PRESETS, ...PANNING_PRESETS]) {
      const e = preset.build();
      expect(e.points.length, preset.name).toBeGreaterThan(0);
      expect(e.points.length, preset.name).toBeLessThanOrEqual(12);
      e.points.forEach((p, i) => {
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(64);
        if (i > 0) expect(p.x, preset.name).toBeGreaterThan(e.points[i - 1]!.x);
      });
      expect(e.points[0]!.x).toBe(0);
      expect(e.sustainPoint).toBeLessThan(e.points.length);
      expect(e.loopEnd).toBeLessThan(e.points.length);
      expect(e.loopStart).toBeLessThanOrEqual(e.loopEnd);
    }
  });

  it('copies by value', () => {
    const e = VOLUME_PRESETS[0]!.build();
    copyEnvelope(e);
    e.points[0]!.y = 1;
    const pasted = pastedEnvelope()!;
    expect(pasted.points[0]!.y).toBe(64);
    pasted.points[0]!.y = 2;
    expect(pastedEnvelope()!.points[0]!.y).toBe(64);
  });
});
