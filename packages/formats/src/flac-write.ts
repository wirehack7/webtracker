/**
 * A small lossless FLAC encoder: fixed predictors (orders 0-4) with
 * partitioned Rice residuals, constant subframes for silence, and the best of
 * the four stereo modes per frame. Chiptunes compress well with that alone.
 */

export type FlacDepth = 16 | 24;

const BLOCK = 4096;
const MAX_RICE = 14;
const MAX_PARTITION_ORDER = 8;

class BitWriter {
  bytes = new Uint8Array(1 << 16);
  pos = 0;
  private acc = 0;
  private bits = 0;

  private grow(extra: number): void {
    if (this.pos + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.pos));
    this.bytes = next;
  }

  /** Writes the low `n` bits of `value` (n ≤ 32), most significant first. */
  write(value: number, n: number): void {
    if (n > 24) {
      this.write(Math.floor(value / 0x10000) & ((1 << (n - 16)) - 1), n - 16);
      this.write(value & 0xffff, 16);
      return;
    }
    this.grow(4);
    this.acc = ((this.acc << n) | (value & ((1 << n) - 1))) >>> 0;
    this.bits += n;
    while (this.bits >= 8) {
      this.bits -= 8;
      this.bytes[this.pos++] = (this.acc >>> this.bits) & 0xff;
    }
    this.acc &= (1 << this.bits) - 1;
  }

  writeSigned(value: number, n: number): void {
    this.write(value < 0 ? value + 2 ** n : value, n);
  }

  /** `count` zero bits and a one. */
  unary(count: number): void {
    while (count >= 24) {
      this.write(0, 24);
      count -= 24;
    }
    this.write(1, count + 1);
  }

  align(): void {
    if (this.bits > 0) this.write(0, 8 - this.bits);
  }
}

const crc8Table = new Uint8Array(256);
const crc16Table = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  crc8Table[i] = c8;
  crc16Table[i] = c16;
}

function crc8(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0;
  for (let i = from; i < to; i++) crc = crc8Table[crc ^ bytes[i]!]!;
  return crc;
}

function crc16(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0;
  for (let i = from; i < to; i++) crc = ((crc << 8) & 0xffff) ^ crc16Table[(crc >> 8) ^ bytes[i]!]!;
  return crc;
}

const zigzag = (r: number) => (r >= 0 ? 2 * r : -2 * r - 1);

/** Residual of the fixed predictor of the given order, for samples order..n-1. */
function fixedResidual(x: Int32Array, order: number): Int32Array {
  const n = x.length;
  const r = new Int32Array(Math.max(0, n - order));
  for (let i = order; i < n; i++) {
    let p: number;
    switch (order) {
      case 0: p = 0; break;
      case 1: p = x[i - 1]!; break;
      case 2: p = 2 * x[i - 1]! - x[i - 2]!; break;
      case 3: p = 3 * x[i - 1]! - 3 * x[i - 2]! + x[i - 3]!; break;
      default: p = 4 * x[i - 1]! - 6 * x[i - 2]! + 4 * x[i - 3]! - x[i - 4]!;
    }
    r[i - order] = x[i]! - p;
  }
  return r;
}

interface RicePlan {
  bits: number;
  partitionOrder: number;
  params: number[];
}

function riceParam(sum: number, count: number): number {
  if (count === 0 || sum <= count) return 0;
  return Math.min(MAX_RICE, Math.floor(Math.log2(sum / count)));
}

/** Picks the partition order and Rice parameters for a residual (with `order` warm-up samples in front). */
function planRice(r: Int32Array, blockSize: number, order: number): RicePlan {
  let best: RicePlan = { bits: Infinity, partitionOrder: 0, params: [] };
  for (let po = 0; po <= MAX_PARTITION_ORDER; po++) {
    const parts = 1 << po;
    if (blockSize % parts !== 0) break;
    const partSize = blockSize / parts;
    if (partSize <= order) break;
    let bits = 4;
    const params: number[] = [];
    let i = 0;
    for (let p = 0; p < parts; p++) {
      const count = p === 0 ? partSize - order : partSize;
      let sum = 0;
      for (let k = 0; k < count; k++) sum += zigzag(r[i + k]!);
      const k = riceParam(sum, count);
      // Each value costs k bits, the stop bit and its quotient in unary.
      bits += 4 + count * (k + 1) + Math.floor(sum / 2 ** k);
      params.push(k);
      i += count;
    }
    if (bits < best.bits) best = { bits, partitionOrder: po, params };
  }
  return best;
}

interface Subframe {
  bits: number;
  write(w: BitWriter): void;
}

function bestSubframe(x: Int32Array, bps: number): Subframe {
  const n = x.length;
  const first = x[0]!;
  if (x.every((v) => v === first)) {
    return {
      bits: 8 + bps,
      write: (w) => {
        w.write(0, 8);
        w.writeSigned(first, bps);
      },
    };
  }

  let best: Subframe = {
    bits: 8 + n * bps,
    write: (w) => {
      w.write(0b00000010, 8);
      for (let i = 0; i < n; i++) w.writeSigned(x[i]!, bps);
    },
  };

  // Pick the order by the residual's size, then plan the Rice coding for it.
  let order = 0;
  let residual = fixedResidual(x, 0);
  let smallest = Infinity;
  for (let o = 0; o <= Math.min(4, n - 1); o++) {
    const r = fixedResidual(x, o);
    let sum = 0;
    for (let i = 0; i < r.length; i++) sum += Math.abs(r[i]!);
    // Normalise to the full block so higher orders are not favoured by fewer samples.
    const score = sum * (n / Math.max(1, r.length));
    if (score < smallest) {
      smallest = score;
      order = o;
      residual = r;
    }
  }
  const plan = planRice(residual, n, order);
  const bits = 8 + order * bps + 2 + plan.bits;
  if (bits < best.bits) {
    const r = residual;
    best = {
      bits,
      write: (w) => {
        w.write(0b00010000 | (order << 1), 8);
        for (let i = 0; i < order; i++) w.writeSigned(x[i]!, bps);
        w.write(0, 2); // Rice coding with 4-bit parameters
        w.write(plan.partitionOrder, 4);
        const parts = 1 << plan.partitionOrder;
        const partSize = n / parts;
        let i = 0;
        for (let p = 0; p < parts; p++) {
          const k = plan.params[p]!;
          w.write(k, 4);
          const end = i + (p === 0 ? partSize - order : partSize);
          for (; i < end; i++) {
            const u = zigzag(r[i]!);
            const q = Math.floor(u / 2 ** k);
            w.unary(q);
            if (k > 0) w.write(u - q * 2 ** k, k);
          }
        }
      },
    };
  }
  return best;
}

/** Frame numbers are stored like UTF-8 code points, up to 36 bits. */
function writeUtf8Number(w: BitWriter, value: number): void {
  if (value < 0x80) {
    w.write(value, 8);
    return;
  }
  let n = 2;
  while (value >= 2 ** (5 * n + 1)) n++;
  const lead = (0xff << (8 - n)) & 0xff;
  w.write(lead | Math.floor(value / 2 ** (6 * (n - 1))), 8);
  for (let i = n - 2; i >= 0; i--) w.write(0x80 | (Math.floor(value / 2 ** (6 * i)) & 0x3f), 8);
}

const RATE_CODES: Record<number, number> = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

/**
 * Encodes the channels (values -1..1, clipped) as a FLAC file. `title` goes
 * into a Vorbis comment when given.
 */
export function encodeFlac(channels: Float32Array[], sampleRate: number, depth: FlacDepth = 16, title = ''): Uint8Array {
  const count = channels.length;
  if (count < 1 || count > 8) throw new Error('FLAC needs 1 to 8 channels');
  const frames = Math.min(...channels.map((c) => c.length));
  const scale = depth === 16 ? 32767 : 8388607;
  const ints = channels.map((c) => {
    const out = new Int32Array(frames);
    for (let i = 0; i < frames; i++) out[i] = Math.round(Math.max(-1, Math.min(1, c[i]!)) * scale);
    return out;
  });

  const w = new BitWriter();
  w.write(0x664c6143, 32); // fLaC

  // STREAMINFO; the frame sizes are filled in once known.
  const comment = vorbisComment(title);
  w.write(0, 1);
  w.write(0, 7);
  w.write(34, 24);
  w.write(BLOCK, 16);
  w.write(BLOCK, 16);
  const frameSizeAt = w.pos;
  w.write(0, 24);
  w.write(0, 24);
  w.write(sampleRate, 20);
  w.write(count - 1, 3);
  w.write(depth - 1, 5);
  w.write(Math.floor(frames / 2 ** 32), 4);
  w.write(frames >>> 0, 32);
  for (let i = 0; i < 4; i++) w.write(0, 32); // MD5 left unset

  w.write(1, 1);
  w.write(4, 7); // VORBIS_COMMENT, the last metadata block
  w.write(comment.length, 24);
  for (const b of comment) w.write(b, 8);

  let minFrame = Infinity;
  let maxFrame = 0;
  for (let start = 0, number = 0; start < frames; start += BLOCK, number++) {
    const size = Math.min(BLOCK, frames - start);
    const block = ints.map((c) => c.subarray(start, start + size));
    const frameStart = w.pos;

    // Stereo: independent, left/side, side/right or mid/side, whatever is smallest.
    let assignment = count - 1;
    let subframes: Subframe[];
    if (count === 2) {
      const [l, r] = block as [Int32Array, Int32Array];
      const side = new Int32Array(size);
      const mid = new Int32Array(size);
      for (let i = 0; i < size; i++) {
        side[i] = l[i]! - r[i]!;
        mid[i] = (l[i]! + r[i]!) >> 1;
      }
      const sl = bestSubframe(l, depth);
      const sr = bestSubframe(r, depth);
      const ss = bestSubframe(side, depth + 1);
      const sm = bestSubframe(mid, depth);
      const options: [number, Subframe[]][] = [
        [1, [sl, sr]],
        [8, [sl, ss]],
        [9, [ss, sr]],
        [10, [sm, ss]],
      ];
      [assignment, subframes] = options.reduce((a, b) => (b[1][0]!.bits + b[1][1]!.bits < a[1][0]!.bits + a[1][1]!.bits ? b : a));
    } else {
      subframes = block.map((c) => bestSubframe(c, depth));
    }

    w.write(0xfff8, 16); // sync, fixed block size
    const sizeCode = size === BLOCK ? 12 : 7;
    w.write(sizeCode, 4);
    w.write(RATE_CODES[sampleRate] ?? 0, 4);
    w.write(assignment, 4);
    w.write(depth === 16 ? 4 : 6, 3);
    w.write(0, 1);
    writeUtf8Number(w, number);
    if (sizeCode === 7) w.write(size - 1, 16);
    w.align();
    w.write(crc8(w.bytes, frameStart, w.pos), 8);

    // Side channels were planned with one extra bit, as the format wants.
    for (const s of subframes) s.write(w);
    w.align();
    w.write(crc16(w.bytes, frameStart, w.pos), 16);

    const frameBytes = w.pos - frameStart;
    minFrame = Math.min(minFrame, frameBytes);
    maxFrame = Math.max(maxFrame, frameBytes);
  }

  const out = w.bytes.slice(0, w.pos);
  if (maxFrame > 0) {
    const put24 = (o: number, v: number) => {
      out[o] = (v >> 16) & 0xff;
      out[o + 1] = (v >> 8) & 0xff;
      out[o + 2] = v & 0xff;
    };
    put24(frameSizeAt, minFrame);
    put24(frameSizeAt + 3, maxFrame);
  }
  return out;
}

function vorbisComment(title: string): Uint8Array {
  const text = new TextEncoder();
  const vendor = text.encode('chiptrackr');
  const fields = title ? [text.encode(`TITLE=${title}`)] : [];
  const size = 4 + vendor.length + 4 + fields.reduce((n, f) => n + 4 + f.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let o = 0;
  v.setUint32(o, vendor.length, true);
  out.set(vendor, o + 4);
  o += 4 + vendor.length;
  v.setUint32(o, fields.length, true);
  o += 4;
  for (const f of fields) {
    v.setUint32(o, f.length, true);
    out.set(f, o + 4);
    o += 4 + f.length;
  }
  return out;
}
