import { Player, type PlayerState, type Song } from '@webtracker/engine';

export const SR = 44100;

export function render(song: Song, seconds: number, setup?: (p: Player) => void) {
  const player = new Player(song, SR);
  const rows: PlayerState[] = [];
  player.onRow = (s) => rows.push(s);
  setup?.(player);
  player.playing = true;
  const frames = Math.round(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  // Render in worklet-sized blocks to exercise block boundaries.
  for (let o = 0; o < frames; o += 128) {
    const n = Math.min(128, frames - o);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    player.process(l, r, n);
    left.set(l, o);
    right.set(r, o);
  }
  return { player, left, right, rows };
}

/** Estimates the fundamental frequency from rising zero crossings. */
export function estimateFrequency(signal: Float32Array, from = 0, to = signal.length): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if (signal[i - 1]! <= 0 && signal[i]! > 0) {
      if (first < 0) first = i;
      else count++;
      last = i;
    }
  }
  return count > 0 ? (count * SR) / (last - first) : 0;
}

export function rms(signal: Float32Array, from = 0, to = signal.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += signal[i]! ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}
