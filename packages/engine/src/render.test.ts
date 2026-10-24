import { describe, expect, it } from 'vitest';
import { createSong, setChannelCount, writeCell } from './edit.ts';
import { renderSong } from './render.ts';
import { readCell } from './song.ts';

const RATE = 22050;
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** One 64-row pattern at speed 6, 125 BPM: 64 * 6 ticks of 20 ms = 7.68 s. */
function song() {
  const s = createSong(4);
  const p = s.patterns[0]!;
  writeCell(s, p, 0, 0, { note: 49, instrument: 1 });
  writeCell(s, p, 0, 2, { note: 37, instrument: 4 });
  return s;
}

describe('renderSong', () => {
  it('stops when the song loops', () => {
    const out = renderSong(song(), { sampleRate: RATE });
    expect(out.left.length / RATE).toBeCloseTo(7.68, 1);
    expect(peak(out.left)).toBeGreaterThan(0.05);
  });

  it('leaves muted channels out', () => {
    const all = renderSong(song(), { sampleRate: RATE, maxSeconds: 1 });
    const none = renderSong(song(), { sampleRate: RATE, maxSeconds: 1, muted: [true, true, true, true] });
    const one = renderSong(song(), { sampleRate: RATE, maxSeconds: 1, muted: [false, true, true, true] });
    const other = renderSong(song(), { sampleRate: RATE, maxSeconds: 1, muted: [true, true, false, true] });
    expect(peak(none.left)).toBe(0);
    expect(peak(one.left)).toBeGreaterThan(0.01);
    // The stems add up to the full mix.
    for (let i = 0; i < all.left.length; i += 97) expect(one.left[i]! + other.left[i]!).toBeCloseTo(all.left[i]!, 5);
  });

  it('reports progress up to 1', () => {
    const seen: number[] = [];
    renderSong(song(), { sampleRate: RATE, onProgress: (f) => seen.push(f) });
    expect(seen.at(-1)).toBe(1);
  });
});

describe('setChannelCount', () => {
  it('keeps the remaining channels and adds empty ones', () => {
    const s = song();
    setChannelCount(s, 2);
    expect(s.channels).toBe(2);
    expect(s.patterns[0]!.data.length).toBe(64 * 2 * 5);
    expect(readCell(s, s.patterns[0]!, 0, 0).note).toBe(49);
    setChannelCount(s, 6);
    expect(s.channelPanning).toHaveLength(6);
    expect(readCell(s, s.patterns[0]!, 0, 0).note).toBe(49);
    expect(readCell(s, s.patterns[0]!, 0, 2).note).toBe(0);
  });
});
