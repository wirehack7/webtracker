import { describe, expect, it } from 'vitest';
import { formatEffect, formatVolume } from './pattern-view.ts';

describe('pattern cell formatting', () => {
  it('formats the volume column', () => {
    expect(formatVolume(0)).toBe('..');
    expect(formatVolume(0x10)).toBe('00');
    expect(formatVolume(0x50)).toBe('40');
    expect(formatVolume(0x6f)).toBe('-F');
    expect(formatVolume(0xf3)).toBe('M3');
  });

  it('formats effects with XM letters', () => {
    expect(formatEffect(0, 0)).toBe('...');
    expect(formatEffect(0x0f, 0x7d)).toBe('F7D');
    expect(formatEffect(0x14, 0)).toBe('K00');
  });
});
