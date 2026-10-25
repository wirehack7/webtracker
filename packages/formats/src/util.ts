import { emptyEnvelope, type Instrument, type Sample } from '@webtracker/engine';

/** Reads a fixed-length, NUL-padded ASCII string. */
export function readString(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = bytes[offset + i] ?? 0;
    if (c === 0) break;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
  }
  return s.trimEnd();
}

/** An instrument that plays one sample on every note, as in formats without instruments. */
export function sampleInstrument(name: string, sample: Sample | null): Instrument {
  return {
    name,
    samples: sample && sample.data.length > 0 ? [sample] : [],
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

/** Unsigned (or signed) 8-bit PCM to -1..1. */
export function pcm8(bytes: Uint8Array, offset: number, frames: number, signed: boolean): Float32Array {
  const n = Math.max(0, Math.min(frames, bytes.length - offset));
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = bytes[offset + i] ?? 0;
    data[i] = (signed ? (v << 24) >> 24 : v - 128) / 128;
  }
  return data;
}
