import { createDemoSong, renderSong } from '@webtracker/engine';
import { describe, expect, it } from 'vitest';
import { SCOPE_POINTS, scopeWave, VIDEO_SAMPLE_RATE, videoFrames } from './frames.ts';

describe('videoFrames', () => {
  it('has the same sound as the audio export', () => {
    const song = createDemoSong();
    const frames = [...videoFrames(song, { fps: 30, maxSeconds: 10 })];
    const audio = renderSong(song, { sampleRate: VIDEO_SAMPLE_RATE, maxSeconds: 10 });
    // 1600 frames of audio per video frame at 30 fps.
    expect(frames).toHaveLength(300);
    expect(frames.every((f) => f.left.length === 1600)).toBe(true);
    expect(frames[10]!.time).toBeCloseTo(10 / 30);
    let differences = 0;
    frames.forEach((f, k) =>
      f.left.forEach((v, i) => {
        if (v !== audio.left[k * 1600 + i] || f.right[i] !== audio.right[k * 1600 + i]) differences++;
      }),
    );
    expect(differences).toBe(0);
  });

  it('follows the order list and reports progress', () => {
    const song = createDemoSong();
    const frames = [...videoFrames(song, { fps: 25 })];
    expect(frames[0]!.state.order).toBe(0);
    const orders = frames.map((f) => f.state.order);
    expect(orders.every((o, i) => i === 0 || o >= orders[i - 1]!)).toBe(true);
    expect(orders.at(-1)).toBe(song.orders.length - 1);
    expect(frames.at(-1)!.progress).toBeGreaterThan(0.8);
    expect(frames[100]!.scopes).toHaveLength(song.channels);
    expect(frames[100]!.scopes[0]).toHaveLength(SCOPE_POINTS);
  });

  it('stops at maxSeconds', () => {
    const frames = [...videoFrames(createDemoSong(), { fps: 30, maxSeconds: 2 })];
    expect(frames).toHaveLength(60);
  });
});

describe('scopeWave', () => {
  it('starts the newest window at a rising zero crossing', () => {
    const ring = Float32Array.from({ length: 576 * 3 }, (_, i) => Math.sin((2 * Math.PI * (i + 17)) / 100) * 2);
    const wave = scopeWave(ring);
    expect(wave).toHaveLength(SCOPE_POINTS);
    expect(Math.abs(wave[0]!)).toBeLessThan(0.2);
    expect(wave[2]!).toBeGreaterThan(wave[0]!);
    // Clipped to the scope's height.
    expect(Math.max(...wave)).toBe(1);
  });

  it('shows silence as a flat line', () => {
    expect(scopeWave(new Float32Array(576 * 3)).every((v) => v === 0)).toBe(true);
  });
});
