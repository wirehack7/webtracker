// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextOf, installDom } from '../test-dom.ts';
import { DEMO_WIDTH, mountAbout, SCROLL_TEXT, scrollerGlyphs } from './about.ts';

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

describe('About dialog', () => {
  let frames: FrameRequestCallback[];
  let reduced: boolean;

  beforeEach(() => {
    installDom();
    frames = [];
    reduced = false;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      if (id > 0) delete frames[id - 1];
    });
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load: () => Promise.resolve([]) } });
    document.body.innerHTML = '<dialog id="about"><canvas class="about-demo" width="320" height="180"></canvas></dialog>';
  });

  afterEach(() => vi.unstubAllGlobals());

  const dialog = () => document.querySelector('dialog')!;
  const canvas = () => document.querySelector<HTMLCanvasElement>('.about-demo')!;
  /** Runs the next animation frame at `ms`. */
  const step = (ms: number) => {
    const pending = frames.filter(Boolean);
    frames = [];
    for (const cb of pending) cb(ms);
  };

  it('opens, draws the demo once the font is there, and animates', async () => {
    const about = mountAbout(dialog());
    about.open();
    expect(dialog().open).toBe(true);
    await vi.waitFor(() => expect(frames.filter(Boolean)).toHaveLength(1));
    step(1000);
    const ctx = contextOf(canvas());
    expect(ctx.texts).toContain('by wirehack7');
    expect(ctx.calls.filter((c) => c.op === 'drawImage').length).toBeGreaterThan(70);
    const firstScroller = ctx.texts.filter((t) => t.length === 1).join('');
    ctx.clear();
    step(1500);
    // Half a second later the scroller has moved on.
    expect(ctx.texts.filter((t) => t.length === 1).join('')).not.toBe(firstScroller);
  });

  it('pauses and resumes on a click, and stops animating when closed', async () => {
    const about = mountAbout(dialog());
    about.open();
    await vi.waitFor(() => expect(frames.filter(Boolean)).toHaveLength(1));
    canvas().click();
    expect(frames.filter(Boolean)).toHaveLength(0);
    canvas().click();
    expect(frames.filter(Boolean)).toHaveLength(1);
    dialog().close();
    expect(frames.filter(Boolean)).toHaveLength(0);
  });

  it('draws one still frame when the system asks for less motion', async () => {
    reduced = true;
    mountAbout(dialog()).open();
    await vi.waitFor(() => expect(contextOf(canvas()).texts).toContain('by wirehack7'));
    expect(frames.filter(Boolean)).toHaveLength(0);
  });
});
