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
});
