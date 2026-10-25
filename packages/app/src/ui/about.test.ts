import { describe, expect, it } from 'vitest';
import { DEMO_WIDTH, SCROLL_TEXT, scrollerGlyphs } from './about.ts';

describe('scrollerGlyphs', () => {
  it('starts with the text at the left edge', () => {
    const glyphs = scrollerGlyphs('ABC', 0, 0, 100, 0);
    expect(glyphs.slice(0, 3).map((g) => [g.char, g.x, g.y])).toEqual([
      ['A', 0, 100],
      ['B', 16, 100],
      ['C', 32, 100],
    ]);
  });

  it('keeps every glyph on screen and skips spaces', () => {
    for (const offset of [0, 7, 333, 12345.5]) {
      const glyphs = scrollerGlyphs(SCROLL_TEXT, offset, 1, 100, 10);
      expect(glyphs.length).toBeGreaterThan(0);
      for (const g of glyphs) {
        expect(g.x).toBeGreaterThan(-16);
        expect(g.x).toBeLessThan(DEMO_WIDTH);
        expect(g.char).not.toBe(' ');
        expect(Math.abs(g.y - 100)).toBeLessThanOrEqual(10);
      }
    }
  });

  it('wraps around so the text repeats', () => {
    const span = SCROLL_TEXT.length * 16;
    expect(scrollerGlyphs(SCROLL_TEXT, span + 40, 0, 0, 0)).toEqual(scrollerGlyphs(SCROLL_TEXT, 40, 0, 0, 0));
  });

  it('names the author', () => {
    expect(SCROLL_TEXT).toContain('wirehack7');
  });
});
