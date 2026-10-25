import { describe, expect, it } from 'vitest';
import { createSong, emptyPattern, MAX_PATTERNS, writeCell } from '@webtracker/engine';
import { freePattern, patternInfos } from './patterns.ts';

describe('patternInfos', () => {
  it('lists rows, positions and blank patterns', () => {
    const song = createSong(4);
    song.patterns.push(emptyPattern(32, 4), emptyPattern(64, 4));
    song.orders = [0, 2, 0];
    writeCell(song, song.patterns[2]!, 0, 0, { note: 49 });
    expect(patternInfos(song)).toEqual([
      { index: 0, rows: 64, positions: [0, 2], empty: true },
      { index: 1, rows: 32, positions: [], empty: true },
      { index: 2, rows: 64, positions: [1], empty: false },
    ]);
  });
});

describe('freePattern', () => {
  it('reuses an unplayed blank pattern before adding one', () => {
    const song = createSong(4);
    song.patterns.push(emptyPattern(64, 4), emptyPattern(64, 4));
    song.orders = [0, 2];
    expect(freePattern(song)).toBe(1);
    writeCell(song, song.patterns[1]!, 0, 0, { note: 49 });
    expect(freePattern(song)).toBe(3);
  });

  it('gives up when every slot is taken', () => {
    const song = createSong(4);
    song.patterns = Array.from({ length: MAX_PATTERNS }, () => emptyPattern(1, 4));
    song.orders = song.patterns.map((_, i) => i);
    expect(freePattern(song)).toBeNull();
  });
});
