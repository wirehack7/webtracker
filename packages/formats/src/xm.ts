import {
  CELL_SIZE,
  LoopType,
  emptyPattern,
  type Envelope,
  type Instrument,
  type Pattern,
  type Sample,
  type Song,
} from '@webtracker/engine';
import { readString } from './util.ts';

const XM_ID = 'Extended Module: ';

export function isXm(bytes: Uint8Array): boolean {
  return bytes.length >= 60 && readString(bytes, 0, 17) === XM_ID.trimEnd();
}

export class Reader {
  private view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length() {
    return this.bytes.length;
  }
  u8(o: number) {
    return this.bytes[o] ?? 0;
  }
  s8(o: number) {
    return (this.u8(o) << 24) >> 24;
  }
  u16(o: number) {
    return o + 2 <= this.bytes.length ? this.view.getUint16(o, true) : 0;
  }
  u32(o: number) {
    return o + 4 <= this.bytes.length ? this.view.getUint32(o, true) : 0;
  }
}

function readEnvelope(r: Reader, pointsAt: number, count: number, sustain: number, loopStart: number, loopEnd: number, type: number): Envelope {
  const points = [];
  const n = Math.min(12, count);
  for (let i = 0; i < n; i++) points.push({ x: r.u16(pointsAt + i * 4), y: Math.min(64, r.u16(pointsAt + i * 4 + 2)) });
  return {
    enabled: (type & 1) !== 0 && n > 0,
    points,
    sustain: (type & 2) !== 0,
    sustainPoint: Math.min(sustain, Math.max(0, n - 1)),
    loop: (type & 4) !== 0,
    loopStart: Math.min(loopStart, Math.max(0, n - 1)),
    loopEnd: Math.min(loopEnd, Math.max(0, n - 1)),
  };
}

/**
 * Reads the instrument fields that XM and XI share, starting at the keymap.
 * Offsets from there: keymap 0, envelopes 96 and 144, envelope settings 192..201,
 * auto-vibrato 202..205, fadeout 206.
 */
export function readInstrumentFields(r: Reader, ins: Instrument, base: number): void {
  for (let k = 0; k < 96; k++) ins.keymap[k] = r.u8(base + k);
  ins.volumeEnvelope = readEnvelope(r, base + 96, r.u8(base + 192), r.u8(base + 194), r.u8(base + 195), r.u8(base + 196), r.u8(base + 200));
  ins.panningEnvelope = readEnvelope(r, base + 144, r.u8(base + 193), r.u8(base + 197), r.u8(base + 198), r.u8(base + 199), r.u8(base + 201));
  ins.vibratoType = r.u8(base + 202);
  ins.vibratoSweep = r.u8(base + 203);
  ins.vibratoDepth = r.u8(base + 204);
  ins.vibratoRate = r.u8(base + 205);
  ins.fadeout = r.u16(base + 206);
}

/** Reads `count` XM sample headers at `o`, then their delta-encoded data. */
export function readSamples(r: Reader, o: number, count: number, headerSize: number): { samples: Sample[]; end: number } {
  const samples: Sample[] = [];
  const headers = [];
  for (let s = 0; s < count; s++) {
    const h = o + s * headerSize;
    headers.push({
      length: r.u32(h),
      loopStart: r.u32(h + 4),
      loopLength: r.u32(h + 8),
      volume: Math.min(64, r.u8(h + 12)),
      finetune: r.s8(h + 13),
      type: r.u8(h + 14),
      panning: r.u8(h + 15),
      relativeNote: r.s8(h + 16),
      name: readString(r.bytes, h + 18, 22),
    });
  }
  o += count * headerSize;

  for (const h of headers) {
    const is16 = (h.type & 0x10) !== 0;
    const bytesAvail = Math.max(0, Math.min(h.length, r.length - o));
    const frames = is16 ? bytesAvail >> 1 : bytesAvail;
    const data = new Float32Array(frames);
    // Sample data is delta encoded.
    let acc = 0;
    if (is16) {
      for (let k = 0; k < frames; k++) {
        acc = (acc + r.u16(o + k * 2)) & 0xffff;
        data[k] = ((acc << 16) >> 16) / 32768;
      }
    } else {
      for (let k = 0; k < frames; k++) {
        acc = (acc + r.u8(o + k)) & 0xff;
        data[k] = ((acc << 24) >> 24) / 128;
      }
    }
    o += h.length;

    const div = is16 ? 2 : 1;
    const loopBits = h.type & 3;
    let loopType: LoopType = loopBits === 2 ? LoopType.PingPong : loopBits ? LoopType.Forward : LoopType.None;
    let loopStart = Math.min(Math.floor(h.loopStart / div), frames);
    let loopLength = Math.min(Math.floor(h.loopLength / div), frames - loopStart);
    if (loopType === LoopType.None || loopLength < 1) {
      loopType = LoopType.None;
      loopStart = 0;
      loopLength = 0;
    }

    const sample: Sample = {
      name: h.name,
      data,
      loopStart,
      loopLength,
      loopType,
      volume: h.volume,
      finetune: h.finetune,
      panning: h.panning,
      relativeNote: h.relativeNote,
    };
    samples.push(sample);
  }
  return { samples, end: o };
}

export function loadXm(buffer: ArrayBuffer): Song {
  const r = new Reader(new Uint8Array(buffer));
  if (!isXm(r.bytes)) throw new Error('Not an XM file');
  const version = r.u16(58);
  if (version < 0x0104) throw new Error(`XM version ${version.toString(16)} is not supported (need 1.04)`);

  const title = readString(r.bytes, 17, 20);
  const tracker = readString(r.bytes, 38, 20);
  const headerSize = r.u32(60);
  const songLength = r.u16(64);
  const restart = r.u16(66);
  const channels = r.u16(68);
  const numPatterns = r.u16(70);
  const numInstruments = r.u16(72);
  const flags = r.u16(74);
  const speed = r.u16(76);
  const tempo = r.u16(78);
  if (channels < 1 || channels > 32) throw new Error(`Unsupported channel count ${channels}`);

  const orders: number[] = [];
  for (let i = 0; i < Math.min(256, songLength); i++) orders.push(r.u8(80 + i));

  let o = 60 + headerSize;
  const patterns: Pattern[] = [];
  for (let p = 0; p < numPatterns; p++) {
    const len = r.u32(o);
    const rows = r.u16(o + 5) || 64;
    const packedSize = r.u16(o + 7);
    o += len;
    const pattern = emptyPattern(rows, channels);
    const end = Math.min(o + packedSize, r.length);
    let src = o;
    for (let i = 0; i < rows * channels && src < end; i++) {
      const d = i * CELL_SIZE;
      const b = r.u8(src++);
      if (b & 0x80) {
        if (b & 1) pattern.data[d] = r.u8(src++);
        if (b & 2) pattern.data[d + 1] = r.u8(src++);
        if (b & 4) pattern.data[d + 2] = r.u8(src++);
        if (b & 8) pattern.data[d + 3] = r.u8(src++);
        if (b & 16) pattern.data[d + 4] = r.u8(src++);
      } else {
        pattern.data[d] = b;
        pattern.data[d + 1] = r.u8(src++);
        pattern.data[d + 2] = r.u8(src++);
        pattern.data[d + 3] = r.u8(src++);
        pattern.data[d + 4] = r.u8(src++);
      }
      if ((pattern.data[d] ?? 0) > 97) pattern.data[d] = 0;
    }
    o += packedSize;
    patterns.push(pattern);
  }

  // Orders may reference patterns that are not stored; those play as empty 64-row patterns.
  const maxOrder = Math.max(0, ...orders);
  while (patterns.length <= maxOrder) patterns.push(emptyPattern(64, channels));

  const instruments: Instrument[] = [];
  for (let i = 0; i < numInstruments && o < r.length; i++) {
    const start = o;
    const insHeaderSize = r.u32(o);
    const name = readString(r.bytes, o + 4, 22);
    const numSamples = r.u16(o + 27);

    const ins: Instrument = {
      name,
      samples: [],
      keymap: new Uint8Array(96),
      volumeEnvelope: readEnvelope(r, 0, 0, 0, 0, 0, 0),
      panningEnvelope: readEnvelope(r, 0, 0, 0, 0, 0, 0),
      fadeout: 0,
      vibratoType: 0,
      vibratoSweep: 0,
      vibratoDepth: 0,
      vibratoRate: 0,
    };

    if (numSamples === 0) {
      o = start + insHeaderSize;
      instruments.push(ins);
      continue;
    }

    const sampleHeaderSize = r.u32(o + 29) || 40;
    readInstrumentFields(r, ins, o + 33);
    o = start + insHeaderSize;
    const read = readSamples(r, o, numSamples, sampleHeaderSize);
    ins.samples = read.samples;
    o = read.end;
    instruments.push(ins);
  }

  return {
    format: 'xm',
    formatName: `XM ${version >> 8}.${(version & 0xff).toString().padStart(2, '0')} (${tracker || 'unknown tracker'})`,
    title,
    channels,
    orders: orders.length ? orders : [0],
    restartPosition: restart < orders.length ? restart : 0,
    patterns,
    instruments,
    linearFrequency: (flags & 1) !== 0,
    initialSpeed: speed || 6,
    initialTempo: tempo || 125,
    channelPanning: new Array(channels).fill(128),
  };
}
