/**
 * Scream Tracker 3 (S3M) loader. The song is converted to the XM-shaped
 * model, as other trackers with an XM core do: Amiga periods, the sample's
 * C-4 rate as relative note and finetune, and S3M commands mapped to their
 * closest XM effects. AdLib instruments have no sample and stay silent.
 */
import {
  CELL_SIZE,
  LoopType,
  NOTE_KEY_OFF,
  emptyEnvelope,
  tuningForRate,
  type Instrument,
  type Pattern,
  type Sample,
  type Song,
} from '@webtracker/engine';
import { readString } from './util.ts';

const ROWS = 64;

export function isS3m(bytes: Uint8Array): boolean {
  return bytes.length >= 96 && readString(bytes, 44, 4) === 'SCRM' && bytes[29] === 16;
}

/** S3M command letter A..Z (1..26) and parameter to an XM effect and parameter. */
export function convertEffect(command: number, info: number): [number, number] {
  const x = info >> 4;
  const y = info & 0x0f;
  switch (String.fromCharCode(64 + command)) {
    case 'A': // set speed
      return info ? [0x0f, Math.min(31, info)] : [0, 0];
    case 'B':
      return [0x0b, info];
    case 'C': // pattern break, BCD row like ProTracker
      return [0x0d, info];
    case 'D': // volume slide, with fine slides on F
      if (x === 0x0f && y) return [0x0e, 0xb0 | y];
      if (y === 0x0f && x) return [0x0e, 0xa0 | x];
      return [0x0a, x && y ? info & 0xf0 : info];
    case 'E': // portamento down, Fx fine, Ex extra fine
      if (x === 0x0f) return [0x0e, 0x20 | y];
      if (x === 0x0e) return [0x21, 0x20 | y];
      return [0x02, info];
    case 'F': // portamento up
      if (x === 0x0f) return [0x0e, 0x10 | y];
      if (x === 0x0e) return [0x21, 0x10 | y];
      return [0x01, info];
    case 'G':
      return [0x03, info];
    case 'H':
      return [0x04, info];
    case 'I': // tremor
      return [0x1d, info];
    case 'J':
      return [0x00, info];
    case 'K':
      return [0x06, info];
    case 'L':
      return [0x05, info];
    case 'O':
      return [0x09, info];
    case 'Q':
      return [0x1b, info];
    case 'R':
      return [0x07, info];
    case 'S':
      switch (x) {
        case 0x1:
          return [0x0e, 0x30 | y];
        case 0x2:
          return [0x0e, 0x50 | y];
        case 0x3:
          return [0x0e, 0x40 | y];
        case 0x4:
          return [0x0e, 0x70 | y];
        case 0x8:
          return [0x08, y * 17];
        case 0xb:
          return [0x0e, 0x60 | y];
        case 0xc:
          return [0x0e, 0xc0 | y];
        case 0xd:
          return [0x0e, 0xd0 | y];
        case 0xe:
          return [0x0e, 0xe0 | y];
      }
      return [0, 0];
    case 'T': // tempo; below 32 is a tempo slide in later trackers, ignored
      return info >= 32 ? [0x0f, info] : [0, 0];
    case 'U': // fine vibrato: a quarter of the depth
      return [0x04, (info & 0xf0) | Math.max(y ? 1 : 0, y >> 2)];
    case 'V':
      return [0x10, Math.min(64, info)];
    case 'X': // 00..80 panning, A4 surround
      return info <= 0x80 ? [0x08, Math.min(255, info * 2)] : [0, 0];
  }
  return [0, 0];
}

export function loadS3m(buffer: ArrayBuffer): Song {
  const bytes = new Uint8Array(buffer);
  if (!isS3m(bytes)) throw new Error('Not an S3M file');
  const u8 = (o: number) => bytes[o] ?? 0;
  const u16 = (o: number) => u8(o) | (u8(o + 1) << 8);
  const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;

  const title = readString(bytes, 0, 28);
  const numOrders = u16(32);
  const numInstruments = u16(34);
  const numPatterns = u16(36);
  const tracker = u16(40);
  const unsignedSamples = u16(42) !== 1;
  const globalVolume = Math.min(64, u8(48) || 64);
  const initialSpeed = u8(49) || 6;
  const initialTempo = u8(50) >= 32 ? u8(50) : 125;
  const stereo = (u8(51) & 0x80) !== 0;
  const hasPanTable = u8(53) === 252;

  // Enabled channels (settings below 16) in their file order, mapped to 0..n-1.
  const channelMap = new Map<number, number>();
  const channelPanning: number[] = [];
  for (let c = 0; c < 32; c++) {
    const setting = u8(64 + c);
    if (setting >= 16) continue;
    channelMap.set(c, channelMap.size);
    channelPanning.push(stereo ? (setting < 8 ? 0x33 : 0xcc) : 128);
  }
  if (channelMap.size === 0) throw new Error('S3M without channels');

  let o = 96;
  const rawOrders = Array.from(bytes.subarray(o, o + numOrders));
  o += numOrders;
  const instrumentPointers = Array.from({ length: numInstruments }, (_, i) => u16(o + i * 2) * 16);
  o += numInstruments * 2;
  const patternPointers = Array.from({ length: numPatterns }, (_, i) => u16(o + i * 2) * 16);
  o += numPatterns * 2;
  if (hasPanTable) {
    for (const [file, index] of channelMap) {
      const pan = u8(o + file);
      if (stereo && pan & 0x20) channelPanning[index] = (pan & 0x0f) * 17;
    }
  }

  // 254 is a skip marker and 255 the end of the song.
  const orders: number[] = [];
  for (const p of rawOrders) {
    if (p === 255) break;
    if (p < numPatterns) orders.push(p);
  }
  if (orders.length === 0) orders.push(0);

  const instruments: Instrument[] = instrumentPointers.map((at) => {
    const name = readString(bytes, at + 48, 28);
    const instrument: Instrument = {
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
    if (at === 0 || u8(at) !== 1) return instrument;
    const offset = ((u8(at + 13) << 16) | u16(at + 14)) * 16;
    const length = u32(at + 16);
    const flags = u8(at + 31);
    const is16 = (flags & 4) !== 0;
    const width = is16 ? 2 : 1;
    // Stereo samples store the left channel, then the right; the left is used.
    const frames = Math.max(0, Math.min(length, Math.floor((bytes.length - offset) / width)));
    const data = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      if (is16) {
        const v = u16(offset + i * 2);
        data[i] = (unsignedSamples ? v - 32768 : (v << 16) >> 16) / 32768;
      } else {
        const v = u8(offset + i);
        data[i] = (unsignedSamples ? v - 128 : (v << 24) >> 24) / 128;
      }
    }
    const loopStart = Math.min(u32(at + 20), frames);
    const loopEnd = Math.min(u32(at + 24), frames);
    const looped = (flags & 1) !== 0 && loopEnd > loopStart + 1;
    const rate = u32(at + 32) || 8363;
    const sample: Sample = {
      name,
      data,
      loopStart: looped ? loopStart : 0,
      loopLength: looped ? loopEnd - loopStart : 0,
      loopType: looped ? LoopType.Forward : LoopType.None,
      volume: Math.min(64, u8(at + 28)),
      panning: 128,
      ...tuningForRate(rate),
    };
    if (frames > 0) instrument.samples.push(sample);
    return instrument;
  });

  const channels = channelMap.size;
  const patterns: Pattern[] = patternPointers.map((at) => {
    const data = new Uint8Array(ROWS * channels * CELL_SIZE);
    if (at === 0) return { rows: ROWS, data };
    const end = Math.min(bytes.length, at + 2 + u16(at));
    let p = at + 2;
    for (let row = 0; row < ROWS && p < end; ) {
      const what = u8(p++);
      if (what === 0) {
        row++;
        continue;
      }
      const index = channelMap.get(what & 31);
      const d = index === undefined ? -1 : (row * channels + index) * CELL_SIZE;
      if (what & 0x20) {
        const note = u8(p);
        const ins = u8(p + 1);
        p += 2;
        if (d >= 0) {
          if (note === 254) data[d] = NOTE_KEY_OFF;
          else if (note < 254) data[d] = Math.max(1, Math.min(96, (note >> 4) * 12 + (note & 0x0f) + 1));
          data[d + 1] = ins;
        }
      }
      if (what & 0x40) {
        const volume = u8(p++);
        if (d >= 0 && volume <= 64) data[d + 2] = 0x10 + volume;
      }
      if (what & 0x80) {
        const [effect, param] = convertEffect(u8(p), u8(p + 1));
        p += 2;
        if (d >= 0) {
          data[d + 3] = effect;
          data[d + 4] = param;
        }
      }
    }
    return { rows: ROWS, data };
  });

  const version = `${(tracker >> 8) & 0x0f}.${(tracker & 0xff).toString(16).padStart(2, '0')}`;
  return {
    format: 'xm',
    formatName: (tracker >> 12) === 1 ? `Scream Tracker ${version} S3M` : 'S3M',
    title,
    channels,
    orders,
    restartPosition: 0,
    patterns,
    instruments,
    linearFrequency: false,
    initialSpeed,
    initialTempo,
    channelPanning,
    initialGlobalVolume: globalVolume,
  };
}
