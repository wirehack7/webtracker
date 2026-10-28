import { Player, type Resampler } from './player.ts';
import type { Song } from './song.ts';

export interface RenderOptions {
  sampleRate?: number;
  /** Stop after this many seconds even if the song never loops. */
  maxSeconds?: number;
  /** Channels left out of the mix, by channel index. */
  muted?: boolean[];
  /** Mixer settings, as on the Player. */
  resampler?: Resampler;
  stereoSeparation?: number;
  volumeRamps?: boolean;
  amplify?: number;
  karplusStrong?: boolean;
  /** Called now and then with how far the song has got, 0..1. */
  onProgress?: (fraction: number) => void;
}

export interface Rendered {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

const BLOCK = 1024;

/**
 * Plays the song from the start through the same Player as the worklet, until
 * it jumps back for the first time (the end of the order list or a backwards
 * Bxx), and returns the stereo output.
 */
export function renderSong(song: Song, options: RenderOptions = {}): Rendered {
  const sampleRate = options.sampleRate ?? 44100;
  const maxFrames = Math.round((options.maxSeconds ?? 20 * 60) * sampleRate);
  const player = new Player(song, sampleRate);
  player.muted = options.muted ?? [];
  player.resampler = options.resampler ?? 'auto';
  player.stereoSeparation = options.stereoSeparation ?? 100;
  player.volumeRamps = options.volumeRamps ?? true;
  player.amplify = options.amplify ?? 100;
  player.karplusStrong = options.karplusStrong ?? false;
  player.playing = true;

  const blocks: [Float32Array, Float32Array][] = [];
  let frames = 0;
  let lastReport = -1;
  while (frames < maxFrames && player.loops === 0 && player.playing) {
    const n = Math.min(BLOCK, maxFrames - frames);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    player.process(left, right, n);
    blocks.push([left, right]);
    frames += n;
    if (options.onProgress && player.order !== lastReport) {
      lastReport = player.order;
      options.onProgress(Math.min(1, player.order / Math.max(1, song.orders.length)));
    }
  }

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let at = 0;
  for (const [l, r] of blocks) {
    left.set(l, at);
    right.set(r, at);
    at += l.length;
  }
  options.onProgress?.(1);
  return { sampleRate, left, right };
}

export interface SongDuration {
  seconds: number;
  /** True when the song did not jump back within the limit, e.g. an endless pattern loop. */
  endless: boolean;
}

/**
 * How long the song plays until it jumps back for the first time, as
 * {@link renderSong} would render it. Runs the player at a low rate without
 * keeping the output, since only the timing matters.
 */
export function songDuration(song: Song, maxSeconds = 20 * 60): SongDuration {
  const sampleRate = 2000;
  const maxFrames = maxSeconds * sampleRate;
  const player = new Player(song, sampleRate);
  player.resampler = 'none';
  player.volumeRamps = false;
  player.playing = true;
  // Small steps, so the jump back is found within 10 ms.
  const step = 20;
  const left = new Float32Array(step);
  const right = new Float32Array(step);
  let frames = 0;
  while (frames < maxFrames && player.loops === 0 && player.playing) {
    player.process(left, right, step);
    frames += step;
  }
  return { seconds: Math.min(frames, maxFrames) / sampleRate, endless: player.loops === 0 && player.playing };
}
