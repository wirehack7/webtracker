import { describe, expect, it } from 'vitest';
import { encodeFlac } from './flac-write.ts';

/** Reads just what the encoder writes: STREAMINFO, a Vorbis comment and fixed-predictor frames. */
function decodeFlac(bytes: Uint8Array) {
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = v * 2 + ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    return v;
  };
  const signed = (n: number) => {
    const v = read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  };
  expect(read(32)).toBe(0x664c6143);
  let sampleRate = 0;
  let channels = 0;
  let depth = 0;
  let total = 0;
  let title = '';
  for (let last = 0; !last; ) {
    last = read(1);
    const type = read(7);
    const length = read(24);
    const start = bit / 8;
    if (type === 0) {
      bit += 16 * 2 + 24 * 2;
      sampleRate = read(20);
      channels = read(3) + 1;
      depth = read(5) + 1;
      total = read(36);
    } else if (type === 4) {
      const v = new DataView(bytes.buffer, start);
      const vendor = v.getUint32(0, true);
      if (v.getUint32(4 + vendor, true) > 0) {
        const size = v.getUint32(8 + vendor, true);
        title = new TextDecoder().decode(bytes.subarray(start + 12 + vendor, start + 12 + vendor + size));
      }
    }
    bit = (start + length) * 8;
  }

  const out = Array.from({ length: channels }, () => [] as number[]);
  while (bit / 8 < bytes.length) {
    expect(read(16)).toBe(0xfff8);
    const sizeCode = read(4);
    read(4);
    const assignment = read(4);
    read(4);
    // The frame number, coded like a UTF-8 code point.
    const lead = read(8);
    let extra = 0;
    if (lead & 0x80) while (lead & (0x40 >> extra)) extra++;
    read(8 * extra);
    const size = sizeCode === 12 ? 4096 : read(16) + 1;
    read(8);
    const subs: number[][] = [];
    for (let c = 0; c < channels; c++) {
      const side = (assignment === 8 && c === 1) || (assignment === 9 && c === 0) || (assignment === 10 && c === 1);
      const bps = depth + (side ? 1 : 0);
      read(1);
      const type = read(6);
      read(1);
      const x: number[] = [];
      if (type === 0) {
        const v = signed(bps);
        for (let i = 0; i < size; i++) x.push(v);
      } else if (type === 1) {
        for (let i = 0; i < size; i++) x.push(signed(bps));
      } else {
        const order = type & 7;
        for (let i = 0; i < order; i++) x.push(signed(bps));
        expect(read(2)).toBe(0);
        const po = read(4);
        const parts = 1 << po;
        for (let p = 0; p < parts; p++) {
          const k = read(4);
          const count = size / parts - (p === 0 ? order : 0);
          for (let i = 0; i < count; i++) {
            let q = 0;
            while (read(1) === 0) q++;
            const u = q * 2 ** k + read(k);
            const r = u % 2 ? -(u + 1) / 2 : u / 2;
            const n = x.length;
            const pred = [0, x[n - 1]!, 2 * x[n - 1]! - x[n - 2]!, 3 * x[n - 1]! - 3 * x[n - 2]! + x[n - 3]!, 4 * x[n - 1]! - 6 * x[n - 2]! + 4 * x[n - 3]! - x[n - 4]!][order]!;
            x.push(pred + r);
          }
        }
      }
      subs.push(x);
    }
    for (let i = 0; i < size; i++) {
      let a = subs[0]![i]!;
      let b = subs[1]?.[i] ?? 0;
      if (assignment === 8) b = a - b;
      else if (assignment === 9) a = a + b;
      else if (assignment === 10) {
        const mid = a * 2 + (b & 1);
        a = (mid + b) >> 1;
        b = (mid - b) >> 1;
      }
      out[0]!.push(a);
      if (channels > 1) out[1]!.push(b);
    }
    bit = Math.ceil(bit / 8) * 8 + 16;
  }
  return { sampleRate, channels, depth, total, title, out };
}

function signal(n: number) {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const part = Math.floor((i / n) * 4);
    l[i] = part === 0 ? 0.8 * Math.sin(i / 20) : part === 1 ? 0 : part === 2 ? (seed / 2 ** 32) * 2 - 1 : 0.4 * Math.sign(Math.sin(i / 50));
    r[i] = part === 0 ? -l[i]! : part === 1 ? 2 : part === 2 ? l[i]! * 0.9 : 0.4 * Math.sign(Math.sin(i / 51));
  }
  return [l, r] as const;
}

describe('encodeFlac', () => {
  for (const depth of [16, 24] as const) {
    it(`round-trips ${depth}-bit stereo exactly`, () => {
      const [l, r] = signal(4096 * 5 + 777);
      const decoded = decodeFlac(encodeFlac([l, r], 48000, depth, 'Pixel Sunrise'));
      const scale = depth === 16 ? 32767 : 8388607;
      const q = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * scale) | 0;
      expect(decoded).toMatchObject({ sampleRate: 48000, channels: 2, depth, total: l.length, title: 'TITLE=Pixel Sunrise' });
      expect(decoded.out[0]).toEqual(Array.from(l, q));
      expect(decoded.out[1]).toEqual(Array.from(r, q));
    });
  }

  it('compresses silence to almost nothing', () => {
    const silent = new Float32Array(44100 * 10);
    expect(encodeFlac([silent, silent], 44100).length).toBeLessThan(2000);
  });
});
