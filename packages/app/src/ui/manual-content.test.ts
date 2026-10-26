import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from './help-content.ts';
import { MANUAL_CHAPTERS } from './manual-content.ts';

describe('manual content', () => {
  it('has anchors that do not clash with each other or with help entries', () => {
    const ids = [
      ...MANUAL_CHAPTERS.map((c) => c.id),
      ...HELP_SECTIONS.map((s) => `ref-${s.id}`),
      ...HELP_SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.entries.flatMap((e) => (e.id ? [e.id] : [])))),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has the chapter the Help dialog links Workflow to', () => {
    expect(MANUAL_CHAPTERS.some((c) => c.id === 'start')).toBe(true);
  });

  it('closes every backtick', () => {
    for (const chapter of MANUAL_CHAPTERS) {
      for (const block of chapter.blocks) {
        const texts = typeof block === 'string' ? [block] : 'list' in block ? block.list : 'steps' in block ? block.steps : [block.tip];
        for (const text of texts) expect(text.split('`').length % 2, text).toBe(1);
      }
    }
  });

  it('has every screenshot at twice the size it is shown at', () => {
    for (const figure of MANUAL_CHAPTERS.flatMap((c) => c.figures ?? [])) {
      const png = readFileSync(new URL(`../../public/manual/${figure.file}`, import.meta.url));
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      // The PNG header (IHDR) holds width and height at bytes 16 and 20.
      expect([view.getUint32(16), view.getUint32(20)], figure.file).toEqual([figure.width * 2, figure.height * 2]);
    }
  });
});
