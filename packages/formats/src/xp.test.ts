import { describe, expect, it } from 'vitest';
import { createSong, emptyPattern, readCell, writeCell } from '@webtracker/engine';
import { applyTrack, loadXp, loadXt, saveXp, saveXt } from './xp.ts';

describe('XP and XT files', () => {
  it('round-trips a pattern through the fixed 32-channel layout', () => {
    const song = createSong(4);
    const pattern = emptyPattern(48, 4);
    writeCell(song, pattern, 5, 3, { note: 49, instrument: 2, volume: 0x30, effect: 0x0a, param: 0x0f });
    const bytes = saveXp(song, pattern);
    expect(bytes.length).toBe(4 + 48 * 32 * 5);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([1, 0, 48, 0]);
    const { pattern: back, droppedChannels } = loadXp(bytes, 4);
    expect(droppedChannels).toBe(0);
    expect(back.rows).toBe(48);
    expect(back.data).toEqual(pattern.data);
  });

  it('reports channels the song cannot hold', () => {
    const wide = createSong(8);
    const pattern = emptyPattern(4, 8);
    writeCell(wide, pattern, 0, 6, { note: 49 });
    const { pattern: back, droppedChannels } = loadXp(saveXp(wide, pattern), 4);
    expect(droppedChannels).toBe(1);
    expect(back.data.length).toBe(4 * 4 * 5);
  });

  it('round-trips a track into another channel', () => {
    const song = createSong(4);
    const pattern = emptyPattern(64, 4);
    writeCell(song, pattern, 2, 1, { note: 97 });
    writeCell(song, pattern, 63, 1, { note: 12, instrument: 1 });
    const cells = loadXt(saveXt(song, pattern, 1));
    const short = emptyPattern(32, 4);
    applyTrack(song, short, 3, cells);
    expect(readCell(song, short, 2, 3).note).toBe(97);
    expect(readCell(song, short, 31, 3).note).toBe(0);
  });

  it('rejects other files', () => {
    expect(() => loadXp(new Uint8Array([2, 0, 64, 0]), 4)).toThrow();
    expect(() => loadXt(new Uint8Array([1, 0, 64, 0]))).toThrow();
  });
});
