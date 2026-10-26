/**
 * Plays a song through the engine one video frame at a time: the audio of
 * each frame plus what the tracker shows at its end (position, row, a scope
 * per channel). The video export draws and encodes these frames.
 */
import { Player, type PlayerState, type Resampler, type Song } from '@webtracker/engine';

/** Video audio runs at 48 kHz, the rate Opus and AAC encoders take everywhere. */
export const VIDEO_SAMPLE_RATE = 48000;
/** Points per scope and frame, already lined up on a rising zero crossing. */
export const SCOPE_POINTS = 256;
/** Audio frames shown across one scope, about 12 ms as in the tracker. */
const SCOPE_WINDOW = 576;

export interface FrameOptions {
  fps: number;
  sampleRate?: number;
  /** Stop after this many seconds even if the song never loops. */
  maxSeconds?: number;
  muted?: boolean[];
  resampler?: Resampler;
  stereoSeparation?: number;
  volumeRamps?: boolean;
  amplify?: number;
  karplusStrong?: boolean;
}

export interface VideoFrame {
  index: number;
  /** Start of the frame in seconds. */
  time: number;
  /** The row playing at the end of the frame. */
  state: PlayerState;
  /** The frame's audio. */
  left: Float32Array;
  right: Float32Array;
  /** One wave per channel, SCOPE_POINTS long, -1..1. */
  scopes: Float32Array[];
  /** How far through the order list the song is, 0..1. */
  progress: number;
}

/**
 * Yields one frame after another until the song jumps back for the first
 * time (the end of the order list or a backwards Bxx), like the audio export.
 */
export function* videoFrames(song: Song, options: FrameOptions): Generator<VideoFrame> {
  const rate = options.sampleRate ?? VIDEO_SAMPLE_RATE;
  const maxSamples = Math.round((options.maxSeconds ?? 20 * 60) * rate);
  const player = new Player(song, rate);
  player.muted = options.muted ?? [];
  player.resampler = options.resampler ?? 'auto';
  player.stereoSeparation = options.stereoSeparation ?? 100;
  player.volumeRamps = options.volumeRamps ?? true;
  player.amplify = options.amplify ?? 100;
  player.karplusStrong = options.karplusStrong ?? false;
  player.enableScopes(SCOPE_WINDOW * 3);
  let state = player.getState();
  // The row that wraps around belongs to the next loop, which is not in the video.
  player.onRow = (next) => {
    if (next.loops === 0) state = next;
  };
  player.playing = true;

  let start = 0;
  for (let index = 0; start < maxSamples && player.loops === 0 && player.playing; index++) {
    const end = Math.min(maxSamples, Math.round(((index + 1) * rate) / options.fps));
    const n = end - start;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    player.process(left, right, n);
    const scopes = player.readScopes().map(scopeWave);
    const progress = Math.min(1, state.order / Math.max(1, song.orders.length));
    yield { index, time: start / rate, state, left, right, scopes, progress };
    start = end;
  }
}

/** The newest window of a channel, starting at a rising zero crossing so waves stand still. */
export function scopeWave(ring: Float32Array): Float32Array {
  const last = ring.length - SCOPE_WINDOW;
  let from = Math.max(0, last - SCOPE_WINDOW);
  let found = -1;
  for (let i = Math.max(1, from); i < last; i++) {
    if (ring[i - 1]! <= 0 && ring[i]! > 0) {
      found = i;
      break;
    }
  }
  from = found < 0 ? Math.max(0, last) : found;
  const out = new Float32Array(SCOPE_POINTS);
  for (let p = 0; p < SCOPE_POINTS; p++) {
    const v = ring[from + Math.floor((p * SCOPE_WINDOW) / SCOPE_POINTS)] ?? 0;
    out[p] = Math.max(-1, Math.min(1, v));
  }
  return out;
}
