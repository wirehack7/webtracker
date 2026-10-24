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

describe('mixer options', () => {
  it('holds each frame without interpolation', () => {
    const s = song();
    const smooth = renderSong(s, { sampleRate: RATE, maxSeconds: 0.2 });
    const raw = renderSong(s, { sampleRate: RATE, maxSeconds: 0.2, resampler: 'none' });
    // Without interpolation the output only has as many distinct levels as the sample has.
    const levels = (a: Float32Array) => new Set(Array.from(a.subarray(2000, 4000), (v) => v.toFixed(5))).size;
    expect(levels(raw.left)).toBeLessThan(levels(smooth.left));
  });

  it('runs the Amiga filters, with E00 switching the LED filter in', () => {
    // Treble energy: the sum of squared differences between neighbouring frames.
    const treble = (a: Float32Array) => a.subarray(2000, 6000).reduce((t, v, i, b) => t + (i ? (v - b[i - 1]!) ** 2 : 0), 0);
    const raw = renderSong(song(), { sampleRate: 44100, maxSeconds: 0.2, resampler: 'none' });
    const amiga = renderSong(song(), { sampleRate: 44100, maxSeconds: 0.2, resampler: 'amiga' });
    const led = song();
    writeCell(led, led.patterns[0]!, 0, 1, { effect: 0x0e, param: 0x00 });
    led.format = 'mod';
    const ledOn = renderSong(led, { sampleRate: 44100, maxSeconds: 0.2 });
    expect(treble(amiga.left)).toBeLessThan(treble(raw.left) * 0.7);
    expect(treble(ledOn.left)).toBeLessThan(treble(amiga.left) * 0.7);
  });

  it('interpolates cubic close to linear on smooth samples', () => {
    const linear = renderSong(song(), { sampleRate: 44100, maxSeconds: 0.2, resampler: 'linear' });
    const cubic = renderSong(song(), { sampleRate: 44100, maxSeconds: 0.2, resampler: 'cubic' });
    const diff = cubic.left.reduce((m, v, i) => Math.max(m, Math.abs(v - linear.left[i]!)), 0);
    expect(peak(cubic.left)).toBeGreaterThan(0.05);
    expect(diff).toBeLessThan(peak(linear.left) * 0.2);
  });

  it('narrows and widens the stereo image', () => {
    const mono = renderSong(song(), { sampleRate: RATE, maxSeconds: 0.5, stereoSeparation: 0 });
    for (let i = 0; i < mono.left.length; i += 101) expect(mono.left[i]).toBeCloseTo(mono.right[i]!, 6);
    const normal = renderSong(song(), { sampleRate: RATE, maxSeconds: 0.5 });
    const wide = renderSong(song(), { sampleRate: RATE, maxSeconds: 0.5, stereoSeparation: 150 });
    const side = (r: { left: Float32Array; right: Float32Array }) => r.left.reduce((t, v, i) => t + Math.abs(v - r.right[i]!), 0);
    expect(side(wide)).toBeGreaterThan(side(normal) * 1.3);
  });
});
