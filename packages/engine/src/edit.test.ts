import { describe, expect, it } from 'vitest';
import {
  blockBetween,
  clearBlock,
  copyBlock,
  createSong,
  deleteRow,
  ensurePattern,
  insertRow,
  pasteClip,
  resizePattern,
  transposeBlock,
  writeCell,
} from './edit.ts';
import { Player } from './player.ts';
import { NOTE_KEY_OFF, readCell } from './song.ts';

function setup() {
  const song = createSong(4);
  return { song, pattern: song.patterns[0]! };
}

describe('writeCell', () => {
  it('sets only the given fields', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 3, 2, { note: 49, instrument: 1 });
    writeCell(song, pattern, 3, 2, { effect: 0xc, param: 0x20 });
    expect(readCell(song, pattern, 3, 2)).toEqual({ note: 49, instrument: 1, volume: 0, effect: 0xc, param: 0x20 });
  });

  it('ignores cells outside the pattern', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 64, 0, { note: 49 });
    writeCell(song, pattern, 0, 4, { note: 49 });
    expect(pattern.data.every((b) => b === 0)).toBe(true);
  });
});

describe('blocks', () => {
  it('normalises corners', () => {
    expect(blockBetween(5, 3, 1, 0)).toEqual({ row0: 1, row1: 5, ch0: 0, ch1: 3 });
  });

  it('copies, clears and pastes a block', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 0, 0, { note: 49, instrument: 1 });
    writeCell(song, pattern, 1, 1, { note: 51, instrument: 2 });
    const clip = copyBlock(song, pattern, blockBetween(0, 0, 1, 1));
    expect(clip.rows).toBe(2);
    expect(clip.channels).toBe(2);

    clearBlock(song, pattern, blockBetween(0, 0, 1, 1));
    expect(readCell(song, pattern, 1, 1).note).toBe(0);

    pasteClip(song, pattern, 10, 2, clip);
    expect(readCell(song, pattern, 10, 2)).toMatchObject({ note: 49, instrument: 1 });
    expect(readCell(song, pattern, 11, 3)).toMatchObject({ note: 51, instrument: 2 });
  });

  it('drops pasted cells past the pattern edge', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 0, 0, { note: 49 });
    writeCell(song, pattern, 0, 1, { note: 50 });
    const clip = copyBlock(song, pattern, blockBetween(0, 0, 0, 1));
    pasteClip(song, pattern, 63, 3, clip);
    expect(readCell(song, pattern, 63, 3).note).toBe(49);
  });

  it('mix-paste keeps fields that are already set', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 0, 0, { note: 49, instrument: 1 });
    writeCell(song, pattern, 5, 0, { note: 60, effect: 0xf, param: 3 });
    const clip = copyBlock(song, pattern, blockBetween(0, 0, 0, 0));
    pasteClip(song, pattern, 5, 0, clip, true);
    expect(readCell(song, pattern, 5, 0)).toEqual({ note: 60, instrument: 1, volume: 0, effect: 0xf, param: 3 });
  });
});

describe('transposeBlock', () => {
  it('moves notes and keeps key-offs and edge notes', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 0, 0, { note: 49 });
    writeCell(song, pattern, 1, 0, { note: NOTE_KEY_OFF });
    writeCell(song, pattern, 2, 0, { note: 96 });
    const changed = transposeBlock(song, pattern, blockBetween(0, 0, 63, 0), 1);
    expect(changed).toBe(1);
    expect(readCell(song, pattern, 0, 0).note).toBe(50);
    expect(readCell(song, pattern, 1, 0).note).toBe(NOTE_KEY_OFF);
    expect(readCell(song, pattern, 2, 0).note).toBe(96);
  });
});

describe('rows', () => {
  it('inserts a row and pushes the rest down within the channels', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 4, 0, { note: 49 });
    writeCell(song, pattern, 4, 1, { note: 50 });
    insertRow(song, pattern, 2, 0, 0);
    expect(readCell(song, pattern, 5, 0).note).toBe(49);
    expect(readCell(song, pattern, 4, 1).note).toBe(50);
  });

  it('deletes a row and pulls the rest up', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 4, 0, { note: 49 });
    writeCell(song, pattern, 63, 0, { note: 60 });
    deleteRow(song, pattern, 2, 0, 3);
    expect(readCell(song, pattern, 3, 0).note).toBe(49);
    expect(readCell(song, pattern, 62, 0).note).toBe(60);
    expect(readCell(song, pattern, 63, 0).note).toBe(0);
  });

  it('resizes and keeps the rows that fit', () => {
    const { song, pattern } = setup();
    writeCell(song, pattern, 10, 0, { note: 49 });
    writeCell(song, pattern, 40, 0, { note: 50 });
    const short = resizePattern(song, pattern, 32);
    expect(short.rows).toBe(32);
    expect(readCell(song, short, 10, 0).note).toBe(49);
    const long = resizePattern(song, short, 128);
    expect(long.rows).toBe(128);
    expect(readCell(song, long, 40, 0).note).toBe(0);
  });

  it('creates missing patterns on demand', () => {
    const { song } = setup();
    ensurePattern(song, 3);
    expect(song.patterns).toHaveLength(4);
    expect(song.patterns[3]!.rows).toBe(64);
  });
});

describe('createSong', () => {
  it('plays a C-4 on the built-in square at about 261 Hz', () => {
    const song = createSong(4);
    writeCell(song, song.patterns[0]!, 0, 0, { note: 49, instrument: 1 });
    const rate = 48000;
    const player = new Player(song, rate);
    player.playing = true;
    const left = new Float32Array(rate);
    const right = new Float32Array(rate);
    player.process(left, right);
    let rising = 0;
    // Skip the first tick so the volume ramp does not count.
    for (let i = 2000; i < left.length; i++) if (left[i - 1]! <= 0 && left[i]! > 0) rising++;
    const hz = (rising * rate) / (left.length - 2000);
    expect(hz).toBeGreaterThan(255);
    expect(hz).toBeLessThan(267);
  });
});
