/** Builds tiny MOD/XM files in memory so tests do not need binary fixtures. */

export interface TestCell {
  note?: number; // XM note 1..96 (97 = key off)
  ins?: number;
  vol?: number; // raw XM volume column byte
  eff?: number;
  param?: number;
}

export type TestPattern = (TestCell | undefined)[][]; // [row][channel]

/** One cycle of a square wave, `length` samples long, as signed 8-bit. */
export function squareWave(length: number, amplitude = 100): Int8Array {
  const data = new Int8Array(length);
  for (let i = 0; i < length; i++) data[i] = i < length / 2 ? amplitude : -amplitude;
  return data;
}

function writeString(bytes: Uint8Array, offset: number, text: string, length: number) {
  for (let i = 0; i < length; i++) bytes[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
}

const AMIGA_PERIODS = [1712, 1616, 1525, 1440, 1357, 1281, 1209, 1141, 1077, 1017, 961, 907];

/** ProTracker period for an XM note number (C-4 = 49 = period 428). */
export function noteToPeriod(note: number): number {
  const n = note - 1 - 24; // 0 = C-2 in XM terms = period 1712
  const octave = Math.floor(n / 12);
  return Math.round(AMIGA_PERIODS[((n % 12) + 12) % 12]! / Math.pow(2, octave));
}

export function buildMod(opts: {
  title?: string;
  samples: { data: Int8Array; volume?: number; finetune?: number; loopStart?: number; loopLength?: number; name?: string }[];
  patterns: TestPattern[];
  orders: number[];
  channels?: number;
}): ArrayBuffer {
  const channels = opts.channels ?? 4;
  const tag = channels === 4 ? 'M.K.' : `${channels}CHN`;
  const sampleBytes = opts.samples.reduce((n, s) => n + s.data.length, 0);
  const size = 1084 + opts.patterns.length * 64 * channels * 4 + sampleBytes;
  const bytes = new Uint8Array(size);
  writeString(bytes, 0, opts.title ?? 'test', 20);
  const w16 = (o: number, v: number) => {
    bytes[o] = v >> 8;
    bytes[o + 1] = v & 0xff;
  };
  for (let i = 0; i < 31; i++) {
    const s = opts.samples[i];
    const o = 20 + i * 30;
    if (!s) continue;
    writeString(bytes, o, s.name ?? `sample${i + 1}`, 22);
    w16(o + 22, s.data.length / 2);
    bytes[o + 24] = (s.finetune ?? 0) & 0x0f;
    bytes[o + 25] = s.volume ?? 64;
    w16(o + 26, (s.loopStart ?? 0) / 2);
    w16(o + 28, (s.loopLength ?? 2) / 2);
  }
  bytes[950] = opts.orders.length;
  bytes[951] = 127;
  opts.orders.forEach((p, i) => (bytes[952 + i] = p));
  writeString(bytes, 1080, tag, 4);
  let o = 1084;
  for (const pattern of opts.patterns) {
    for (let row = 0; row < 64; row++) {
      for (let ch = 0; ch < channels; ch++) {
        const c = pattern[row]?.[ch];
        if (c) {
          const period = c.note ? noteToPeriod(c.note) : 0;
          const ins = c.ins ?? 0;
          bytes[o] = (ins & 0xf0) | (period >> 8);
          bytes[o + 1] = period & 0xff;
          bytes[o + 2] = ((ins & 0x0f) << 4) | ((c.eff ?? 0) & 0x0f);
          bytes[o + 3] = c.param ?? 0;
        }
        o += 4;
      }
    }
  }
  for (const s of opts.samples) {
    bytes.set(new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.length), o);
    o += s.data.length;
  }
  return bytes.buffer;
}

export interface TestXmSample {
  data: Int8Array | Int16Array;
  volume?: number;
  finetune?: number;
  panning?: number;
  relativeNote?: number;
  loop?: 'none' | 'forward' | 'pingpong';
  loopStart?: number;
  loopLength?: number;
}

export interface TestXmInstrument {
  name?: string;
  samples: TestXmSample[];
  volumeEnvelope?: { points: [number, number][]; sustain?: number; loop?: [number, number] };
  fadeout?: number;
}

class ByteWriter {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number) {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }
  str(s: string, len: number) {
    for (let i = 0; i < len; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0);
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
  }
}

export function buildXm(opts: {
  title?: string;
  channels: number;
  orders: number[];
  patterns: { rows: number; cells: TestPattern }[];
  instruments: TestXmInstrument[];
  linear?: boolean;
  speed?: number;
  tempo?: number;
  restart?: number;
}): ArrayBuffer {
  const w = new ByteWriter();
  w.str('Extended Module: ', 17);
  w.str(opts.title ?? 'test', 20);
  w.u8(0x1a);
  w.str('webtracker tests', 20);
  w.u16(0x0104);
  w.u32(276);
  w.u16(opts.orders.length);
  w.u16(opts.restart ?? 0);
  w.u16(opts.channels);
  w.u16(opts.patterns.length);
  w.u16(opts.instruments.length);
  w.u16(opts.linear === false ? 0 : 1);
  w.u16(opts.speed ?? 6);
  w.u16(opts.tempo ?? 125);
  for (let i = 0; i < 256; i++) w.u8(opts.orders[i] ?? 0);

  for (const p of opts.patterns) {
    const packed = new ByteWriter();
    for (let row = 0; row < p.rows; row++) {
      for (let ch = 0; ch < opts.channels; ch++) {
        const c = p.cells[row]?.[ch];
        if (!c) {
          packed.u8(0x80);
          continue;
        }
        let flags = 0x80;
        if (c.note) flags |= 1;
        if (c.ins) flags |= 2;
        if (c.vol) flags |= 4;
        if (c.eff) flags |= 8;
        if (c.param) flags |= 16;
        packed.u8(flags);
        if (c.note) packed.u8(c.note);
        if (c.ins) packed.u8(c.ins);
        if (c.vol) packed.u8(c.vol);
        if (c.eff) packed.u8(c.eff);
        if (c.param) packed.u8(c.param);
      }
    }
    w.u32(9);
    w.u8(0);
    w.u16(p.rows);
    w.u16(packed.bytes.length);
    w.bytes.push(...packed.bytes);
  }

  for (const ins of opts.instruments) {
    w.u32(263);
    w.str(ins.name ?? 'ins', 22);
    w.u8(0);
    w.u16(ins.samples.length);
    w.u32(40);
    w.zeros(96); // keymap: everything to sample 0
    const env = ins.volumeEnvelope;
    for (let i = 0; i < 12; i++) {
      const pt = env?.points[i];
      w.u16(pt?.[0] ?? 0);
      w.u16(pt?.[1] ?? 0);
    }
    w.zeros(48); // panning envelope
    w.u8(env?.points.length ?? 0);
    w.u8(0);
    w.u8(env?.sustain ?? 0);
    w.u8(env?.loop?.[0] ?? 0);
    w.u8(env?.loop?.[1] ?? 0);
    w.zeros(3);
    w.u8(env ? 1 | (env.sustain !== undefined ? 2 : 0) | (env.loop ? 4 : 0) : 0);
    w.u8(0);
    w.zeros(4); // auto vibrato
    w.u16(ins.fadeout ?? 0);
    w.zeros(22);

    for (const s of ins.samples) {
      const is16 = s.data instanceof Int16Array;
      const bps = is16 ? 2 : 1;
      w.u32(s.data.length * bps);
      w.u32((s.loopStart ?? 0) * bps);
      w.u32((s.loopLength ?? 0) * bps);
      w.u8(s.volume ?? 64);
      w.u8(s.finetune ?? 0);
      const loop = s.loop === 'forward' ? 1 : s.loop === 'pingpong' ? 2 : 0;
      w.u8(loop | (is16 ? 0x10 : 0));
      w.u8(s.panning ?? 128);
      w.u8(s.relativeNote ?? 0);
      w.u8(0);
      w.str('smp', 22);
    }
    for (const s of ins.samples) {
      let prev = 0;
      for (let i = 0; i < s.data.length; i++) {
        const value = s.data[i]!;
        const delta = value - prev;
        prev = value;
        if (s.data instanceof Int16Array) w.u16(delta & 0xffff);
        else w.u8(delta & 0xff);
      }
    }
  }
  return new Uint8Array(w.bytes).buffer;
}

export interface TestS3mCell {
  note?: number; // S3M note byte: octave << 4 | semitone, 254 = note cut
  ins?: number;
  vol?: number; // 0..64
  cmd?: string; // command letter A..Z
  info?: number;
}

/** Builds a Scream Tracker 3 module with 8-bit samples (unsigned, as ST3 writes them). */
export function buildS3m(opts: {
  title?: string;
  samples: { data: Int8Array; volume?: number; c2spd?: number; loopStart?: number; loopEnd?: number }[];
  patterns: (TestS3mCell | undefined)[][][];
  orders: number[];
  channelSettings?: number[]; // channel setting bytes, default 0,8,9,1 (L R R L)
  panning?: number[]; // optional pan table entries (0..15), one per channel
  speed?: number;
  tempo?: number;
  mono?: boolean;
}): ArrayBuffer {
  const w = new ByteWriter();
  const settings = opts.channelSettings ?? [0, 8, 9, 1];
  w.str(opts.title ?? 'test', 28);
  w.u8(0x1a);
  w.u8(16);
  w.u16(0);
  w.u16(opts.orders.length);
  w.u16(opts.samples.length);
  w.u16(opts.patterns.length);
  w.u16(0); // flags
  w.u16(0x1320); // Scream Tracker 3.20
  w.u16(2); // unsigned samples
  w.str('SCRM', 4);
  w.u8(64); // global volume
  w.u8(opts.speed ?? 6);
  w.u8(opts.tempo ?? 125);
  w.u8(opts.mono ? 48 : 0x80 | 48);
  w.u8(0); // ultra click
  w.u8(opts.panning ? 252 : 0);
  while (w.bytes.length < 64) w.u8(0);
  for (let c = 0; c < 32; c++) w.u8(settings[c] ?? 255);
  for (const p of opts.orders) w.u8(p);
  // Parapointers are patched once the blocks are laid out.
  const pointerAt = w.bytes.length;
  for (let i = 0; i < opts.samples.length + opts.patterns.length; i++) w.u16(0);
  if (opts.panning) for (let c = 0; c < 32; c++) w.u8(c < opts.panning.length ? 0x20 | opts.panning[c]! : 0);
  const align = () => {
    while (w.bytes.length % 16) w.u8(0);
    return w.bytes.length / 16;
  };
  const patch = (index: number, para: number) => {
    w.bytes[pointerAt + index * 2] = para & 0xff;
    w.bytes[pointerAt + index * 2 + 1] = para >> 8;
  };
  const headers: number[] = [];
  opts.samples.forEach((s, i) => {
    const para = align();
    patch(i, para);
    headers.push(w.bytes.length);
    w.u8(1);
    w.str('', 12);
    w.u8(0);
    w.u16(0); // memseg, patched below
    w.u32(s.data.length);
    w.u32(s.loopStart ?? 0);
    w.u32(s.loopEnd ?? 0);
    w.u8(s.volume ?? 64);
    w.u8(0);
    w.u8(0);
    w.u8(s.loopEnd ? 1 : 0);
    w.u32(s.c2spd ?? 8363);
    w.str('', 12);
    w.str(`sample${i + 1}`, 28);
    w.str('SCRS', 4);
  });
  opts.patterns.forEach((pattern, i) => {
    patch(opts.samples.length + i, align());
    const start = w.bytes.length;
    w.u16(0);
    for (let row = 0; row < 64; row++) {
      pattern[row]?.forEach((c, ch) => {
        if (!c) return;
        let what = ch;
        if (c.note !== undefined || c.ins !== undefined) what |= 0x20;
        if (c.vol !== undefined) what |= 0x40;
        if (c.cmd) what |= 0x80;
        w.u8(what);
        if (what & 0x20) {
          w.u8(c.note ?? 255);
          w.u8(c.ins ?? 0);
        }
        if (what & 0x40) w.u8(c.vol!);
        if (what & 0x80) {
          w.u8(c.cmd!.charCodeAt(0) - 64);
          w.u8(c.info ?? 0);
        }
      });
      w.u8(0);
    }
    const length = w.bytes.length - start;
    w.bytes[start] = length & 0xff;
    w.bytes[start + 1] = length >> 8;
  });
  opts.samples.forEach((s, i) => {
    const para = align();
    w.bytes[headers[i]! + 14] = para & 0xff;
    w.bytes[headers[i]! + 15] = para >> 8;
    for (const v of s.data) w.u8(v + 128);
  });
  return new Uint8Array(w.bytes).buffer;
}

/** IT 2.14/2.15 sample compression, choosing the narrowest bit width for every value. */
export function compressIt(values: Int8Array | Int16Array, it215: boolean): Uint8Array {
  const is16 = values instanceof Int16Array;
  const bits = is16 ? 16 : 8;
  const fullWidth = bits + 1;
  const blockFrames = is16 ? 0x4000 : 0x8000;
  const out: number[] = [];
  for (let start = 0; start < values.length; start += blockFrames) {
    const block = values.subarray(start, start + blockFrames);
    const stream: number[] = [];
    let bitPos = 0;
    const write = (v: number, n: number) => {
      for (let i = 0; i < n; i++, bitPos++) {
        if ((bitPos & 7) === 0) stream.push(0);
        stream[stream.length - 1]! |= ((v >> i) & 1) << (bitPos & 7);
      }
    };
    const wrap = (v: number) => (v << (32 - bits)) >> (32 - bits);
    // Whether `v` can be written at width `w` without looking like a width change.
    const fits = (v: number, w: number) => {
      if (w === fullWidth) return true;
      if (v < -(1 << (w - 1)) || v >= 1 << (w - 1)) return false;
      const u = v & ((1 << w) - 1);
      if (w < 7) return u !== 1 << (w - 1);
      const border = ((is16 ? 0xffff : 0xff) >> (fullWidth - w)) - (is16 ? 8 : 4);
      return !(u > border && u <= border + (is16 ? 16 : 8));
    };
    let width = fullWidth;
    let d1 = 0;
    let d2 = 0;
    for (const value of block) {
      // The decoder adds deltas up once (2.14) or twice (2.15).
      let v: number;
      if (it215) {
        const nd1 = wrap(value - d2);
        v = wrap(nd1 - d1);
        d1 = nd1;
        d2 = value;
      } else {
        v = wrap(value - d1);
        d1 = value;
      }
      let w = 1;
      while (!fits(v, w)) w++;
      if (w !== width) {
        if (width < 7) {
          write(1 << (width - 1), width);
          write((w < width ? w : w - 1) - 1, is16 ? 4 : 3);
        } else if (width < fullWidth) {
          const border = ((is16 ? 0xffff : 0xff) >> (fullWidth - width)) - (is16 ? 8 : 4);
          write(border + (w < width ? w : w - 1), width);
        } else {
          write((1 << bits) | (w - 1), width);
        }
        width = w;
      }
      // At full width the top bit marks a width change, so the value keeps only `bits` bits.
      write(v & ((1 << Math.min(width, bits)) - 1), width);
    }
    out.push(stream.length & 0xff, stream.length >> 8, ...stream);
  }
  return new Uint8Array(out);
}

export interface TestItCell {
  note?: number; // IT note 0..119, 254 cut, 255 off
  ins?: number;
  vol?: number; // raw IT volume column
  cmd?: string;
  info?: number;
}

export interface TestItSample {
  data: Int8Array | Int16Array;
  volume?: number;
  globalVolume?: number;
  c5speed?: number;
  loop?: [number, number];
  pingpong?: boolean;
  pan?: number; // 0..64, sets the default pan flag
  compressed?: 'it214' | 'it215';
}

export interface TestItInstrument {
  name?: string;
  /** Sample number (1-based) for every IT note, or one sample for all notes. */
  keyboard: number | number[];
  fadeout?: number;
  volumeEnvelope?: { points: [number, number][]; sustain?: number; loop?: [number, number] };
  panningEnvelope?: { points: [number, number][] };
}

export function buildIt(opts: {
  title?: string;
  samples: TestItSample[];
  instruments?: TestItInstrument[];
  patterns: { rows?: number; cells: (TestItCell | undefined)[][] }[];
  orders: number[];
  linear?: boolean;
  stereo?: boolean;
  channelPan?: number[];
  globalVolume?: number;
  speed?: number;
  tempo?: number;
}): ArrayBuffer {
  const w = new ByteWriter();
  const instruments = opts.instruments ?? [];
  w.str('IMPM', 4);
  w.str(opts.title ?? 'test', 26);
  w.u16(0x1004);
  w.u16(opts.orders.length);
  w.u16(instruments.length);
  w.u16(opts.samples.length);
  w.u16(opts.patterns.length);
  w.u16(0x0214);
  w.u16(0x0214);
  w.u16((opts.stereo === false ? 0 : 1) | (instruments.length ? 4 : 0) | (opts.linear === false ? 0 : 8));
  w.u16(0);
  w.u8(opts.globalVolume ?? 128);
  w.u8(48);
  w.u8(opts.speed ?? 6);
  w.u8(opts.tempo ?? 125);
  w.u8(128);
  w.u8(0);
  w.u16(0);
  w.u32(0);
  w.u32(0);
  for (let c = 0; c < 64; c++) w.u8(opts.channelPan?.[c] ?? 32);
  for (let c = 0; c < 64; c++) w.u8(64);
  for (const p of opts.orders) w.u8(p);
  const pointers = w.bytes.length;
  const count = instruments.length + opts.samples.length + opts.patterns.length;
  for (let i = 0; i < count; i++) w.u32(0);
  const patch = (index: number, at: number) => {
    for (let b = 0; b < 4; b++) w.bytes[pointers + index * 4 + b] = (at >>> (b * 8)) & 0xff;
  };
  const envelope = (env: { points: [number, number][]; sustain?: number; loop?: [number, number] } | undefined) => {
    const start = w.bytes.length;
    if (env) {
      w.u8(1 | (env.loop ? 2 : 0) | (env.sustain !== undefined ? 4 : 0));
      w.u8(env.points.length);
      w.u8(env.loop?.[0] ?? 0);
      w.u8(env.loop?.[1] ?? 0);
      w.u8(env.sustain ?? 0);
      w.u8(env.sustain ?? 0);
      for (const [x, y] of env.points) {
        w.u8(y);
        w.u16(x);
      }
    }
    while (w.bytes.length < start + 82) w.u8(0);
  };
  instruments.forEach((ins, i) => {
    patch(i, w.bytes.length);
    const start = w.bytes.length;
    w.str('IMPI', 4);
    w.str('', 12);
    w.u8(0);
    w.u8(0); // NNA
    w.u8(0);
    w.u8(0);
    w.u16(ins.fadeout ?? 0);
    w.u8(0);
    w.u8(60);
    w.u8(128);
    w.u8(32);
    w.u8(0);
    w.u8(0);
    w.u16(0x0214);
    w.u8(0);
    w.u8(0);
    w.str(ins.name ?? `instrument${i + 1}`, 26);
    w.zeros(6);
    for (let n = 0; n < 120; n++) {
      w.u8(n);
      w.u8(typeof ins.keyboard === 'number' ? ins.keyboard : (ins.keyboard[n] ?? 0));
    }
    envelope(ins.volumeEnvelope);
    envelope(ins.panningEnvelope);
    envelope(undefined);
    while (w.bytes.length < start + 554) w.u8(0);
  });
  const sampleHeaders: number[] = [];
  opts.samples.forEach((s, i) => {
    patch(instruments.length + i, w.bytes.length);
    sampleHeaders.push(w.bytes.length);
    const is16 = s.data instanceof Int16Array;
    w.str('IMPS', 4);
    w.str('', 12);
    w.u8(0);
    w.u8(s.globalVolume ?? 64);
    w.u8(1 | (is16 ? 2 : 0) | (s.compressed ? 8 : 0) | (s.loop ? 0x10 : 0) | (s.pingpong ? 0x40 : 0));
    w.u8(s.volume ?? 64);
    w.str(`sample${i + 1}`, 26);
    w.u8(1 | (s.compressed === 'it215' ? 4 : 0));
    w.u8(s.pan === undefined ? 32 : 0x80 | s.pan);
    w.u32(s.data.length);
    w.u32(s.loop?.[0] ?? 0);
    w.u32(s.loop?.[1] ?? 0);
    w.u32(s.c5speed ?? 8363);
    w.u32(0);
    w.u32(0);
    w.u32(0); // pointer, patched below
    w.zeros(4);
  });
  opts.patterns.forEach((pattern, i) => {
    patch(instruments.length + opts.samples.length + i, w.bytes.length);
    const rows = pattern.rows ?? 64;
    const start = w.bytes.length;
    w.u16(0);
    w.u16(rows);
    w.zeros(4);
    for (let row = 0; row < rows; row++) {
      pattern.cells[row]?.forEach((c, ch) => {
        if (!c) return;
        const mask = (c.note !== undefined ? 1 : 0) | (c.ins !== undefined ? 2 : 0) | (c.vol !== undefined ? 4 : 0) | (c.cmd ? 8 : 0);
        w.u8((ch + 1) | 0x80);
        w.u8(mask);
        if (mask & 1) w.u8(c.note!);
        if (mask & 2) w.u8(c.ins!);
        if (mask & 4) w.u8(c.vol!);
        if (mask & 8) {
          w.u8(c.cmd!.charCodeAt(0) - 64);
          w.u8(c.info ?? 0);
        }
      });
      w.u8(0);
    }
    const length = w.bytes.length - start - 8;
    w.bytes[start] = length & 0xff;
    w.bytes[start + 1] = length >> 8;
  });
  opts.samples.forEach((s, i) => {
    const at = w.bytes.length;
    for (let b = 0; b < 4; b++) w.bytes[sampleHeaders[i]! + 0x48 + b] = (at >>> (b * 8)) & 0xff;
    if (s.compressed) {
      for (const b of compressIt(s.data, s.compressed === 'it215')) w.u8(b);
    } else if (s.data instanceof Int16Array) {
      for (const v of s.data) w.u16(v);
    } else {
      for (const v of s.data) w.u8(v);
    }
  });
  return new Uint8Array(w.bytes).buffer;
}

/** Cell for the small formats: raw note and instrument numbers as the format stores them. */
export interface TestRawCell {
  note?: number;
  ins?: number;
  vol?: number;
  eff?: number;
  param?: number;
}

export function buildMtm(opts: {
  samples: { data: Int8Array; volume?: number; finetune?: number; loop?: [number, number] }[];
  patterns: (TestRawCell | undefined)[][][]; // [pattern][row][channel]
  orders: number[];
  channels?: number;
  pan?: number[];
  rows?: number;
}): ArrayBuffer {
  const w = new ByteWriter();
  const channels = opts.channels ?? 4;
  // One track per pattern channel.
  const tracks: number[][] = [];
  const sequence: number[] = [];
  for (const pattern of opts.patterns) {
    for (let c = 0; c < 32; c++) {
      if (c >= channels) {
        sequence.push(0);
        continue;
      }
      const track: number[] = [];
      for (let row = 0; row < 64; row++) {
        const cell = pattern[row]?.[c];
        const note = cell?.note ?? 0;
        const ins = cell?.ins ?? 0;
        track.push((note << 2) | (ins >> 4), ((ins & 0x0f) << 4) | (cell?.eff ?? 0), cell?.param ?? 0);
      }
      tracks.push(track);
      sequence.push(tracks.length);
    }
  }
  w.str('MTM', 3);
  w.u8(0x10);
  w.str('mtm test', 20);
  w.u16(tracks.length);
  w.u8(opts.patterns.length - 1);
  w.u8(opts.orders.length - 1);
  w.u16(0);
  w.u8(opts.samples.length);
  w.u8(0);
  w.u8(opts.rows ?? 64);
  w.u8(channels);
  for (let c = 0; c < 32; c++) w.u8(opts.pan?.[c] ?? (c & 1 ? 12 : 3));
  opts.samples.forEach((s, i) => {
    w.str(`sample${i + 1}`, 22);
    w.u32(s.data.length);
    w.u32(s.loop?.[0] ?? 0);
    w.u32(s.loop?.[1] ?? 0);
    w.u8((s.finetune ?? 0) & 0xff);
    w.u8(s.volume ?? 64);
    w.u8(0);
  });
  for (let i = 0; i < 128; i++) w.u8(opts.orders[i] ?? 0);
  for (const track of tracks) for (const b of track) w.u8(b);
  for (const t of sequence) w.u16(t);
  for (const s of opts.samples) for (const v of s.data) w.u8(v + 128);
  return new Uint8Array(w.bytes).buffer;
}

export function build669(opts: {
  samples: { data: Int8Array; loop?: [number, number] }[];
  patterns: { cells: (TestRawCell | undefined)[][]; speed?: number; breakRow?: number }[];
  orders: number[];
}): ArrayBuffer {
  const w = new ByteWriter();
  w.str('if', 2);
  w.str('669 test', 108);
  w.u8(opts.samples.length);
  w.u8(opts.patterns.length);
  w.u8(0);
  for (let i = 0; i < 128; i++) w.u8(opts.orders[i] ?? 0xff);
  for (let i = 0; i < 128; i++) w.u8(opts.patterns[i]?.speed ?? 4);
  for (let i = 0; i < 128; i++) w.u8(opts.patterns[i]?.breakRow ?? 63);
  opts.samples.forEach((s, i) => {
    w.str(`s${i + 1}.smp`, 13);
    w.u32(s.data.length);
    w.u32(s.loop?.[0] ?? 0);
    w.u32(s.loop?.[1] ?? 0xfffff);
  });
  for (const pattern of opts.patterns) {
    for (let row = 0; row < 64; row++) {
      for (let c = 0; c < 8; c++) {
        const cell = pattern.cells[row]?.[c];
        if (cell?.note !== undefined) {
          const ins = cell.ins ?? 0;
          w.u8((cell.note << 2) | (ins >> 4));
          w.u8(((ins & 0x0f) << 4) | (cell.vol ?? 15));
        } else if (cell?.vol !== undefined) {
          w.u8(0xfe);
          w.u8(cell.vol);
        } else {
          w.u8(0xff);
          w.u8(0);
        }
        w.u8(cell?.eff !== undefined ? (cell.eff << 4) | (cell.param ?? 0) : 0xff);
      }
    }
  }
  for (const s of opts.samples) for (const v of s.data) w.u8(v + 128);
  return new Uint8Array(w.bytes).buffer;
}

export function buildOkt(opts: {
  split?: number[];
  samples: { data: Int8Array; volume?: number; loop?: [number, number]; type?: number }[];
  patterns: { rows?: number; cells: (TestRawCell | undefined)[][] }[];
  orders: number[];
  speed?: number;
}): ArrayBuffer {
  const out: number[] = [];
  const be16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff);
  const be32 = (v: number) => {
    be16(v >>> 16);
    be16(v & 0xffff);
  };
  const str = (s: string, n: number) => {
    for (let i = 0; i < n; i++) out.push(i < s.length ? s.charCodeAt(i) : 0);
  };
  const split = opts.split ?? [0, 0, 0, 0];
  const channels = 4 + split.reduce((a, b) => a + b, 0);
  str('OKTASONG', 8);
  str('CMOD', 4);
  be32(8);
  for (const s of split) be16(s);
  str('SAMP', 4);
  be32(opts.samples.length * 32);
  opts.samples.forEach((s, i) => {
    str(`sample${i + 1}`, 20);
    be32(s.data.length);
    be16((s.loop?.[0] ?? 0) / 2);
    be16((s.loop?.[1] ?? 0) / 2);
    be16(s.volume ?? 64);
    be16(s.type ?? 2);
  });
  str('SPEE', 4);
  be32(2);
  be16(opts.speed ?? 6);
  str('SLEN', 4);
  be32(2);
  be16(opts.patterns.length);
  str('PLEN', 4);
  be32(2);
  be16(opts.orders.length);
  str('PATT', 4);
  be32(128);
  for (let i = 0; i < 128; i++) out.push(opts.orders[i] ?? 0);
  for (const pattern of opts.patterns) {
    const rows = pattern.rows ?? 64;
    str('PBOD', 4);
    be32(2 + rows * channels * 4);
    be16(rows);
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < channels; c++) {
        const cell = pattern.cells[row]?.[c];
        out.push(cell?.note ?? 0, cell?.ins ?? 0, cell?.eff ?? 0, cell?.param ?? 0);
      }
    }
  }
  for (const s of opts.samples) {
    str('SBOD', 4);
    be32(s.data.length);
    for (const v of s.data) out.push(v & 0xff);
  }
  return new Uint8Array(out).buffer;
}
