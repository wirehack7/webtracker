/**
 * Sample operations for the sample editor. Each one changes the sample in
 * place (replacing `data` where the length changes) and keeps the loop
 * inside the data.
 */

import { emptyEnvelope, LoopType, type Instrument, type Sample } from './song.ts';

/** Half-open frame range [start, end). */
export interface Range {
  start: number;
  end: number;
}

function clampRange(sample: Sample, range: Range): Range {
  const len = sample.data.length;
  const start = Math.max(0, Math.min(len, Math.floor(Math.min(range.start, range.end))));
  const end = Math.max(start, Math.min(len, Math.floor(Math.max(range.start, range.end))));
  return { start, end };
}

/** Keeps the loop inside the sample; a loop that no longer fits is switched off. */
export function fixLoop(sample: Sample): void {
  const len = sample.data.length;
  sample.loopStart = Math.max(0, Math.min(len, Math.floor(sample.loopStart)));
  sample.loopLength = Math.max(0, Math.min(len - sample.loopStart, Math.floor(sample.loopLength)));
  if (sample.loopLength < 1) {
    sample.loopType = LoopType.None;
    sample.loopLength = 0;
    if (len === 0) sample.loopStart = 0;
  }
}

export function emptySample(name = ''): Sample {
  return {
    name,
    data: new Float32Array(0),
    loopStart: 0,
    loopLength: 0,
    loopType: LoopType.None,
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
  };
}

export function emptyInstrument(name = ''): Instrument {
  return {
    name,
    samples: [],
    keymap: new Uint8Array(96),
    volumeEnvelope: emptyEnvelope(),
    panningEnvelope: emptyEnvelope(),
    fadeout: 0,
    vibratoType: 0,
    vibratoSweep: 0,
    vibratoDepth: 0,
    vibratoRate: 0,
  };
}

/** Copy of the frames in the range. */
export function copyRange(sample: Sample, range: Range): Float32Array {
  const r = clampRange(sample, range);
  return sample.data.slice(r.start, r.end);
}

/** Removes the range; loop points after it move left. */
export function deleteRange(sample: Sample, range: Range): void {
  const r = clampRange(sample, range);
  const removed = r.end - r.start;
  if (removed === 0) return;
  const data = new Float32Array(sample.data.length - removed);
  data.set(sample.data.subarray(0, r.start));
  data.set(sample.data.subarray(r.end), r.start);
  sample.data = data;
  const loopEnd = sample.loopStart + sample.loopLength;
  const shift = (p: number) => (p <= r.start ? p : p >= r.end ? p - removed : r.start);
  sample.loopStart = shift(sample.loopStart);
  sample.loopLength = shift(loopEnd) - sample.loopStart;
  fixLoop(sample);
}

/** Keeps only the range. */
export function cropRange(sample: Sample, range: Range): void {
  const r = clampRange(sample, range);
  const len = sample.data.length;
  deleteRange(sample, { start: r.end, end: len });
  deleteRange(sample, { start: 0, end: r.start });
}

/** Inserts frames at `at`; loop points after it move right. */
export function insertFrames(sample: Sample, at: number, frames: Float32Array): void {
  const pos = Math.max(0, Math.min(sample.data.length, Math.floor(at)));
  const data = new Float32Array(sample.data.length + frames.length);
  data.set(sample.data.subarray(0, pos));
  data.set(frames, pos);
  data.set(sample.data.subarray(pos), pos + frames.length);
  sample.data = data;
  if (sample.loopStart >= pos && sample.loopLength > 0) sample.loopStart += frames.length;
  else if (sample.loopStart + sample.loopLength > pos) sample.loopLength += frames.length;
  fixLoop(sample);
}

function mapRange(sample: Sample, range: Range, fn: (v: number, i: number, n: number) => number): void {
  const r = clampRange(sample, range);
  const n = r.end - r.start;
  for (let i = 0; i < n; i++) sample.data[r.start + i] = fn(sample.data[r.start + i]!, i, n);
}

const clip = (v: number) => Math.max(-1, Math.min(1, v));

export function silenceRange(sample: Sample, range: Range): void {
  mapRange(sample, range, () => 0);
}

export function reverseRange(sample: Sample, range: Range): void {
  const r = clampRange(sample, range);
  sample.data.subarray(r.start, r.end).reverse();
}

export function amplifyRange(sample: Sample, range: Range, factor: number): void {
  mapRange(sample, range, (v) => clip(v * factor));
}

/** Scales the range so its loudest frame reaches full scale. */
export function normalizeRange(sample: Sample, range: Range): void {
  const r = clampRange(sample, range);
  let peak = 0;
  for (let i = r.start; i < r.end; i++) peak = Math.max(peak, Math.abs(sample.data[i]!));
  if (peak > 0) amplifyRange(sample, r, 1 / peak);
}

export function fadeIn(sample: Sample, range: Range): void {
  mapRange(sample, range, (v, i, n) => v * (n > 1 ? i / (n - 1) : 1));
}

export function fadeOut(sample: Sample, range: Range): void {
  mapRange(sample, range, (v, i, n) => v * (n > 1 ? 1 - i / (n - 1) : 0));
}

/** Turns the waveform upside down (phase invert). */
export function invertRange(sample: Sample, range: Range): void {
  mapRange(sample, range, (v) => -v);
}

/**
 * Flips the sign bit as if the frames were 8-bit: fixes samples that were
 * imported as signed when they were unsigned, or the other way round.
 */
export function toggleSignRange(sample: Sample, range: Range): void {
  mapRange(sample, range, (v) => {
    const byte = Math.max(-128, Math.min(127, Math.round(v * 128)));
    return ((byte ^ 0x80) << 24 >> 24) / 128;
  });
}

/** Swaps the two bytes of each 16-bit frame: fixes samples imported with the wrong byte order. */
export function swapBytesRange(sample: Sample, range: Range): void {
  mapRange(sample, range, (v) => {
    const word = Math.max(-32768, Math.min(32767, Math.round(v * 32768))) & 0xffff;
    return ((((word & 0xff) << 8) | (word >> 8)) << 16 >> 16) / 32768;
  });
}

/** Removes the DC offset: shifts the range so its average is zero. */
export function removeDcRange(sample: Sample, range: Range): void {
  const r = clampRange(sample, range);
  if (r.end <= r.start) return;
  let sum = 0;
  for (let i = r.start; i < r.end; i++) sum += sample.data[i]!;
  const mean = sum / (r.end - r.start);
  mapRange(sample, r, (v) => clip(v - mean));
}

/** Rounds every frame to 8 bits, so the sample is saved (and sounds) as 8-bit. */
export function quantize8(sample: Sample): void {
  mapRange(sample, { start: 0, end: sample.data.length }, (v) => Math.max(-128, Math.min(127, Math.round(v * 128))) / 128);
}

/**
 * One-pole low-pass or high-pass filter over the range. `cutoff` is in Hz
 * at the given sample rate.
 */
export function filterRange(sample: Sample, range: Range, kind: 'lowpass' | 'highpass', cutoff: number, rate: number): void {
  const r = clampRange(sample, range);
  const k = 1 - Math.exp((-2 * Math.PI * Math.min(cutoff, rate / 2)) / rate);
  let low = sample.data[r.start] ?? 0;
  for (let i = r.start; i < r.end; i++) {
    const v = sample.data[i]!;
    low += (v - low) * k;
    sample.data[i] = kind === 'lowpass' ? low : clip(v - low);
  }
}

/**
 * Smooths the loop seam: the last `frames` frames of the loop are faded
 * into the frames just before the loop start, so the jump back is seamless.
 * Returns how many frames were blended (0 when the loop leaves no room).
 */
export function crossfadeLoop(sample: Sample, frames: number): number {
  if (sample.loopType === LoopType.None || sample.loopLength <= 0) return 0;
  const start = sample.loopStart;
  const end = start + sample.loopLength;
  const n = Math.floor(Math.min(frames, start, sample.loopLength / 2));
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const at = end - n + i;
    sample.data[at] = sample.data[at]! * (1 - t) + sample.data[start - n + i]! * t;
  }
  return n;
}

/** The rate a sample plays at on C-4, from its relative note and finetune. */
export function rateForTuning(relativeNote: number, finetune: number): number {
  return 8363 * Math.pow(2, (relativeNote + finetune / 128) / 12);
}

/** Relative note and finetune that make a sample recorded at `rate` Hz play at pitch on C-4. */
export function tuningForRate(rate: number): { relativeNote: number; finetune: number } {
  const semitones = 12 * Math.log2(rate / 8363);
  let relativeNote = Math.round(semitones);
  let finetune = Math.round((semitones - relativeNote) * 128);
  if (finetune > 127) {
    finetune -= 128;
    relativeNote++;
  }
  return { relativeNote: Math.max(-96, Math.min(95, relativeNote)), finetune: Math.max(-128, Math.min(127, finetune)) };
}

/**
 * Stretches the sample to `factor` times its length with linear
 * interpolation and retunes it so it keeps its pitch, as FT2's resample does.
 */
export function resample(sample: Sample, factor: number): void {
  const len = sample.data.length;
  const newLen = Math.max(1, Math.round(len * factor));
  if (len === 0 || newLen === len) return;
  const data = new Float32Array(newLen);
  const ratio = len / newLen;
  for (let i = 0; i < newLen; i++) {
    const pos = i * ratio;
    const a = pos | 0;
    const frac = pos - a;
    const x = sample.data[a] ?? 0;
    const y = sample.data[Math.min(len - 1, a + 1)] ?? x;
    data[i] = x + (y - x) * frac;
  }
  sample.data = data;
  sample.loopStart = Math.round(sample.loopStart * (newLen / len));
  sample.loopLength = Math.round(sample.loopLength * (newLen / len));
  fixLoop(sample);

  const pitch = sample.relativeNote * 128 + sample.finetune + Math.round(12 * Math.log2(newLen / len) * 128);
  sample.relativeNote = Math.max(-96, Math.min(95, Math.floor((pitch + 64) / 128)));
  sample.finetune = Math.max(-128, Math.min(127, pitch - sample.relativeNote * 128));
}

// ---- Chip waveforms ---------------------------------------------------------

export const WAVE_SHAPES = ['square', 'pulse25', 'pulse12', 'triangle', 'saw', 'sine', 'noise'] as const;
export type WaveShape = (typeof WAVE_SHAPES)[number];

/** Rounds to 8-bit steps so the wave is stored exactly in an 8-bit sample. */
const to8 = (v: number) => Math.max(-128, Math.min(127, Math.round(v * 96))) / 128;

/**
 * One cycle (or for noise, `length` frames) of a waveform at about 75% of
 * full scale. Looped and played at 8363 Hz on C-4, a 32-frame cycle sounds
 * at 261 Hz, so 32 frames is the natural length.
 */
export function generateWave(shape: WaveShape, length = 32, seed = 1): Float32Array {
  const n = Math.max(2, Math.floor(length));
  let state = seed >>> 0 || 1;
  const random = () => {
    // xorshift32, deterministic so the same noise comes back after undo.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  return Float32Array.from({ length: n }, (_, i) => {
    const p = i / n;
    switch (shape) {
      case 'square':
        return to8(p < 0.5 ? 1 : -1);
      case 'pulse25':
        return to8(p < 0.25 ? 1 : -1);
      case 'pulse12':
        return to8(p < 0.125 ? 1 : -1);
      case 'triangle':
        return to8(p < 0.5 ? 4 * p - 1 : 3 - 4 * p);
      case 'saw':
        return to8(2 * p - 1);
      case 'sine':
        return to8(Math.sin(2 * Math.PI * p));
      case 'noise':
        return to8(random() * 2 - 1);
    }
  });
}
