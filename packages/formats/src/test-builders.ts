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
