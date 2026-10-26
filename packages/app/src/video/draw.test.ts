import { createDemoSong, createSong } from '@webtracker/engine';
import { describe, expect, it } from 'vitest';
import { THEME_PROPERTIES, VideoPainter, videoLayout, type Box, type VideoTheme } from './draw.ts';
import { SCOPE_POINTS } from './frames.ts';

const SIZES = [
  [1280, 720],
  [1920, 1080],
  [1080, 1080],
  [1080, 1920],
] as const;

const inside = (box: Box, width: number, height: number) => box.x >= 0 && box.y >= 0 && box.x + box.w <= width && box.y + box.h <= height;

describe('videoLayout', () => {
  for (const [width, height] of SIZES) {
    it(`fits 1 to 32 channels into ${width}x${height}`, () => {
      for (const channels of [1, 2, 4, 8, 12, 16, 24, 32]) {
        const layout = videoLayout(width, height, channels);
        for (const box of [layout.header, layout.scopes, layout.pattern]) expect(inside(box, width, height)).toBe(true);
        expect(layout.header.y + layout.header.h).toBeLessThanOrEqual(layout.scopes.y);
        expect(layout.scopes.y + layout.scopes.h).toBeLessThanOrEqual(layout.pattern.y);
        // Every channel's text fits its column.
        expect((layout.chars + 1) * layout.font).toBeLessThanOrEqual(layout.channelWidth + layout.font);
        expect(layout.rowNumberWidth + channels * layout.channelWidth).toBeLessThanOrEqual(layout.pattern.w);
        expect(layout.pattern.h / layout.rowHeight).toBeGreaterThan(10);
      }
    });
  }

  it('shows every field for a 4 or 8 channel song in 720p', () => {
    expect(videoLayout(1280, 720, 4).chars).toBe(13);
    expect(videoLayout(1280, 720, 8).chars).toBe(13);
    expect(videoLayout(1280, 720, 32).chars).toBe(3);
  });
});

/** Records what is drawn, enough to run the painter without a browser. */
function fakeContext() {
  const texts: string[] = [];
  const g = {
    fillStyle: '',
    font: '',
    textBaseline: '',
    globalAlpha: 1,
    fillRect() {},
    fillText(text: string) {
      texts.push(text);
    },
    measureText: (text: string) => ({ width: text.length * 16 }),
    drawImage() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
  };
  return { g, texts, canvas: { getContext: () => g } };
}

describe('VideoPainter', () => {
  it('draws title, position and the pattern text', () => {
    const song = createDemoSong();
    const { g, texts, canvas } = fakeContext();
    const theme = Object.fromEntries(Object.keys(THEME_PROPERTIES).map((k) => [k, '#fff'])) as unknown as VideoTheme;
    const painter = new VideoPainter({
      song,
      title: 'Pixel Sunrise',
      theme,
      layout: videoLayout(1280, 720, song.channels),
      muted: [],
      beat: 4,
      bar: 16,
      makeCanvas: () => canvas as unknown as OffscreenCanvas,
    });
    const scopes = Array.from({ length: song.channels }, () => new Float32Array(SCOPE_POINTS));
    const state = { order: 1, pattern: song.orders[1]!, row: 10, speed: 6, tempo: 125, playing: true, loops: 0 };
    painter.draw(g as unknown as OffscreenCanvasRenderingContext2D, state, scopes, 75);
    expect(texts).toContain('Pixel Sunrise');
    expect(texts.find((t) => t.startsWith('POS 01/'))).toContain('ROW 0A');
    expect(texts.find((t) => t.startsWith('POS'))).toContain('1:15');
    expect(texts).toContain('3F');
  });

  it('cuts a long title to fit', () => {
    const song = createSong(4);
    const { g, texts, canvas } = fakeContext();
    const painter = new VideoPainter({
      song,
      title: 'A'.repeat(200),
      theme: Object.fromEntries(Object.keys(THEME_PROPERTIES).map((k) => [k, '#fff'])) as unknown as VideoTheme,
      layout: videoLayout(1280, 720, 4),
      muted: [true],
      beat: 0,
      bar: 0,
      makeCanvas: () => canvas as unknown as OffscreenCanvas,
    });
    painter.draw(g as unknown as OffscreenCanvasRenderingContext2D, { order: 0, pattern: 0, row: 0, speed: 6, tempo: 125, playing: true, loops: 0 }, [], 0);
    const title = texts.find((t) => t.startsWith('AAA'))!;
    expect(title.endsWith('...')).toBe(true);
    expect(title.length).toBeLessThan(200);
  });
});
