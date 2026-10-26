import { describe, expect, it } from 'vitest';
import { createSong, writeCell } from './edit.ts';
import { Player } from './player.ts';
import { emptyPattern, type Song } from './song.ts';

/** Five 4-row patterns played out of numeric order, with a repeat and a Bxx jump back. */
function song(format: 'mod' | 'xm'): Song {
  const s = createSong(4);
  s.format = format;
  s.patterns = Array.from({ length: 5 }, () => emptyPattern(4, s.channels));
  s.orders = [0, 1, 4, 3, 2, 1];
  // The last row of the last position jumps back to position 2.
  writeCell(s, s.patterns[1]!, 3, 0, { effect: 0xb, param: 2 });
  return s;
}

/** The patterns that play, one per order position reached. */
function playedPatterns(s: Song, positions: number): number[] {
  const player = new Player(s, 8000);
  const seen: number[] = [];
  let last = -1;
  player.onRow = (state) => {
    if (state.order !== last) seen.push(state.pattern);
    last = state.order;
  };
  player.playing = true;
  const left = new Float32Array(256);
  const right = new Float32Array(256);
  for (let i = 0; i < 2000 && seen.length < positions; i++) player.process(left, right, 256);
  return seen;
}

describe('order list playback', () => {
  for (const format of ['xm', 'mod'] as const) {
    it(`plays the positions in order list order (${format})`, () => {
      // Pattern 1 jumps to position 2 both times: after position 1 and at the end.
      expect(playedPatterns(song(format), 8)).toEqual([0, 1, 4, 3, 2, 1, 4, 3]);
    });
  }

  it('starts from the position it is reset to', () => {
    const player = new Player(song('xm'), 8000);
    player.reset(3, 0);
    expect(player.getState().pattern).toBe(3);
  });
});
