/**
 * Impulse Tracker (IT) loader. Like S3M, the song is converted to the
 * XM-shaped model: instruments keep their keyboard map, volume and panning
 * envelopes and fadeout; samples become per-instrument sample lists; IT
 * commands and volume-column commands map to their closest XM effects.
 * New note actions, the pitch envelope, filters and MIDI macros are not
 * modelled and are dropped.
 */
import {
  CELL_SIZE,
  LoopType,
  NOTE_KEY_OFF,
  emptyEnvelope,
  tuningForRate,
  type Envelope,
  type Instrument,
  type Pattern,
  type Sample,
  type Song,
} from '@webtracker/engine';
import { convertEffect as convertS3mEffect } from './s3m.ts';
import { readString } from './util.ts';

const MAX_CHANNELS = 32;

export function isIt(bytes: Uint8Array): boolean {
  return bytes.length >= 0xc0 && readString(bytes, 0, 4) === 'IMPM';
}

/** IT command letter A..Z (1..26) and parameter to an XM effect and parameter. */
export function convertEffect(command: number, info: number, oldEffects = false): [number, number] {
  const x = info >> 4;
  const y = info & 0x0f;
  switch (String.fromCharCode(64 + command)) {
    case 'H': // vibrato: without Old Effects IT swings half as far as XM
    case 'U': {
      const [effect, param] = convertS3mEffect(command, info);
      return oldEffects ? [effect, param] : [effect, (param & 0xf0) | halfDepth(param & 0x0f)];
    }
    case 'C': // pattern break: IT stores the row in hex, XM reads it as decimal digits
      return [0x0d, Math.min(63, info) % 10 | (Math.floor(Math.min(63, info) / 10) << 4)];
    case 'P': // panning slide: IT P0x slides right, Px0 left; XM has the nibbles the other way
      if ((x === 0x0f && y) || (y === 0x0f && x)) return [0, 0];
      return [0x19, (y << 4) | x];
    case 'S':
      // S9x surround, SAx high offset, S5x panbrello waveform, S6x fine pattern delay, S7x NNA: no XM form.
      if (x === 0x5 || x === 0x6 || x === 0x7 || x === 0x9 || x === 0xa) return [0, 0];
      return convertS3mEffect(command, info);
    case 'T': // tempo; T0x/T1x tempo slides are dropped
      return info >= 0x20 ? [0x0f, info] : [0, 0];
    case 'V': // global volume 0..128
      return [0x10, Math.min(64, info >> 1)];
    case 'W': // global volume slide on the 0..128 scale, halved for XM; fine slides are dropped
      if ((x === 0x0f && y) || (y === 0x0f && x)) return [0, 0];
      return [0x11, x ? Math.ceil(x / 2) << 4 : Math.ceil(y / 2)];
    case 'X': // full range panning
      return [0x08, info];
    case 'M': // channel volume
    case 'N': // channel volume slide
    case 'Y': // panbrello
    case 'Z': // MIDI macro
      return [0, 0];
  }
  return convertS3mEffect(command, info);
}

const halfDepth = (depth: number) => (depth ? Math.max(1, Math.round(depth / 2)) : 0);

const TONE_PORTA_SPEEDS = [0, 1, 4, 8, 16, 32, 64, 96, 128, 255];

/**
 * IT volume column to an XM volume column byte. Pitch slides have no XM volume
 * column form, and tone portamento only a coarse one; they come back as an
 * effect that replaces the volume column when the effect column is free.
 */
export function convertVolume(v: number, oldEffects = false): { volume: number; effect?: [number, number] } {
  if (v <= 64) return { volume: 0x10 + v };
  if (v <= 74) return { volume: 0x90 | (v - 65) };
  if (v <= 84) return { volume: 0x80 | (v - 75) };
  if (v <= 94) return { volume: 0x70 | (v - 85) };
  if (v <= 104) return { volume: 0x60 | (v - 95) };
  if (v <= 114) return { volume: 0, effect: [0x02, (v - 105) * 4] };
  if (v <= 124) return { volume: 0, effect: [0x01, (v - 115) * 4] };
  if (v >= 128 && v <= 192) return { volume: 0xc0 | Math.min(15, Math.round(((v - 128) * 15) / 64)) };
  if (v >= 193 && v <= 202) {
    // XM's volume column only has steps of 16, so the exact speed goes to the effect column when it is free.
    const speed = TONE_PORTA_SPEEDS[v - 193]!;
    return { volume: 0xf0 | Math.min(15, Math.ceil(speed / 16)), effect: [0x03, speed] };
  }
  if (v >= 203 && v <= 212) return { volume: 0xb0 | (oldEffects ? v - 203 : halfDepth(v - 203)) };
  return { volume: 0 };
}

/** Reads `count` sample frames compressed with IT 2.14 (or 2.15 when `it215`). */
export function decompressIt(
  bytes: Uint8Array,
  offset: number,
  count: number,
  is16: boolean,
  it215: boolean,
): Float32Array {
  const out = new Float32Array(count);
  const blockFrames = is16 ? 0x4000 : 0x8000;
  const fullWidth = is16 ? 17 : 9;
  const bits = is16 ? 16 : 8;
  let pos = 0;
  let o = offset;
  while (pos < count && o + 2 <= bytes.length) {
    const blockBytes = (bytes[o] ?? 0) | ((bytes[o + 1] ?? 0) << 8);
    o += 2;
    const end = Math.min(bytes.length, o + blockBytes);
    let bitPos = o * 8;
    const read = (n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++, bitPos++) {
        const byte = bitPos >> 3;
        if (byte >= end) return v;
        v |= (((bytes[byte] ?? 0) >> (bitPos & 7)) & 1) << i;
      }
      return v;
    };
    const blockEnd = Math.min(count, pos + blockFrames);
    let width = fullWidth;
    let d1 = 0;
    let d2 = 0;
    while (pos < blockEnd && bitPos < end * 8) {
      let v = read(width);
      if (width < 7) {
        // Method 1: a single set top bit announces a new width in 3 bits.
        if (v === 1 << (width - 1)) {
          const w = read(is16 ? 4 : 3) + 1;
          width = w < width ? w : w + 1;
          continue;
        }
      } else if (width < fullWidth) {
        // Method 2: a band of values just below the top announces a new width.
        const border = ((is16 ? 0xffff : 0xff) >> (fullWidth - width)) - (is16 ? 8 : 4);
        if (v > border && v <= border + (is16 ? 16 : 8)) {
          v -= border;
          width = v < width ? v : v + 1;
          continue;
        }
      } else {
        // Method 3: full width plus one bit; the top bit announces a new width.
        if (v & (1 << bits)) {
          width = (v + 1) & 0xff;
          continue;
        }
      }
      if (width < bits) {
        const shift = 32 - width;
        v = (v << shift) >> shift;
      } else {
        v = (v << (32 - bits)) >> (32 - bits);
      }
      d1 = ((d1 + v) << (32 - bits)) >> (32 - bits);
      d2 = ((d2 + d1) << (32 - bits)) >> (32 - bits);
      out[pos++] = (it215 ? d2 : d1) / (is16 ? 32768 : 128);
    }
    o = end;
    pos = blockEnd;
  }
  return out;
}

/** Envelope with one held point, so key off starts the fadeout instead of cutting the note as XM does. */
function heldEnvelope(): Envelope {
  return {
    enabled: true,
    points: [
      { x: 0, y: 64 },
      { x: 1, y: 64 },
    ],
    sustain: true,
    sustainPoint: 0,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
  };
}

const AUTO_VIBRATO_TYPES = [0, 2, 1, 3]; // IT sine, ramp down, square, random to XM order

export function loadIt(buffer: ArrayBuffer): Song {
  const bytes = new Uint8Array(buffer);
  if (!isIt(bytes)) throw new Error('Not an IT file');
  const u8 = (o: number) => bytes[o] ?? 0;
  const s8 = (o: number) => (u8(o) << 24) >> 24;
  const u16 = (o: number) => u8(o) | (u8(o + 1) << 8);
  const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;

  const title = readString(bytes, 4, 26);
  const numOrders = u16(0x20);
  const numInstruments = u16(0x22);
  const numSamples = u16(0x24);
  const numPatterns = u16(0x26);
  const createdWith = u16(0x28);
  const compatible = u16(0x2a);
  const flags = u16(0x2c);
  const stereo = (flags & 1) !== 0;
  const useInstruments = (flags & 4) !== 0;
  const linear = (flags & 8) !== 0;
  const oldEffects = (flags & 16) !== 0;
  const globalVolume = Math.min(64, u8(0x30) >> 1);
  const initialSpeed = u8(0x32) || 6;
  const initialTempo = u8(0x33) >= 32 ? u8(0x33) : 125;

  let o = 0xc0;
  const rawOrders = Array.from(bytes.subarray(o, o + numOrders));
  o += numOrders;
  const instrumentOffsets = Array.from({ length: numInstruments }, (_, i) => u32(o + i * 4));
  o += numInstruments * 4;
  const sampleOffsets = Array.from({ length: numSamples }, (_, i) => u32(o + i * 4));
  o += numSamples * 4;
  const patternOffsets = Array.from({ length: numPatterns }, (_, i) => u32(o + i * 4));

  // 254 is a skip marker and 255 the end of the song.
  const orders: number[] = [];
  for (const p of rawOrders) {
    if (p === 255) break;
    if (p < numPatterns) orders.push(p);
  }
  if (orders.length === 0) orders.push(0);

  type ItSample = { sample: Sample; vibrato: [number, number, number, number] };
  const samples: (ItSample | null)[] = sampleOffsets.map((at) => {
    if (at === 0 || readString(bytes, at, 4) !== 'IMPS') return null;
    const sampleFlags = u8(at + 0x12);
    const name = readString(bytes, at + 0x14, 26);
    const convert = u8(at + 0x2e);
    const defaultPan = u8(at + 0x2f);
    const length = u32(at + 0x30);
    const is16 = (sampleFlags & 2) !== 0;
    const width = is16 ? 2 : 1;
    const pointer = u32(at + 0x48);
    let data: Float32Array;
    if (!(sampleFlags & 1) || length === 0) {
      data = new Float32Array(0);
    } else if (sampleFlags & 8) {
      data = decompressIt(bytes, pointer, length, is16, (convert & 4) !== 0);
    } else {
      // Stereo samples store the left channel, then the right; the left is used.
      const frames = Math.max(0, Math.min(length, Math.floor((bytes.length - pointer) / width)));
      const signed = (convert & 1) !== 0;
      data = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        if (is16) {
          const v = u16(pointer + i * 2);
          data[i] = (signed ? (v << 16) >> 16 : v - 32768) / 32768;
        } else {
          const v = u8(pointer + i);
          data[i] = (signed ? (v << 24) >> 24 : v - 128) / 128;
        }
      }
    }
    // The sample's global volume has no place in the model; it is applied to the data.
    const sampleGlobal = Math.min(64, u8(at + 0x11)) / 64;
    if (sampleGlobal < 1) for (let i = 0; i < data.length; i++) data[i]! *= sampleGlobal;

    const frames = data.length;
    // A sustain loop stands in for the loop when there is no regular one.
    let loopFlag = (sampleFlags & 0x10) !== 0;
    let pingpong = (sampleFlags & 0x40) !== 0;
    let loopStart = u32(at + 0x34);
    let loopEnd = u32(at + 0x38);
    if (!loopFlag && sampleFlags & 0x20) {
      loopFlag = true;
      pingpong = (sampleFlags & 0x80) !== 0;
      loopStart = u32(at + 0x40);
      loopEnd = u32(at + 0x44);
    }
    loopStart = Math.min(loopStart, frames);
    loopEnd = Math.min(loopEnd, frames);
    const looped = loopFlag && loopEnd > loopStart + 1;
    const sample: Sample = {
      name,
      data,
      loopStart: looped ? loopStart : 0,
      loopLength: looped ? loopEnd - loopStart : 0,
      loopType: looped ? (pingpong ? LoopType.PingPong : LoopType.Forward) : LoopType.None,
      volume: Math.min(64, u8(at + 0x13)),
      panning: defaultPan & 0x80 ? Math.min(255, (defaultPan & 0x7f) * 4) : 128,
      usePanning: (defaultPan & 0x80) !== 0,
      ...tuningForRate(u32(at + 0x3c) || 8363),
    };
    return { sample, vibrato: [u8(at + 0x4c), u8(at + 0x4d), u8(at + 0x4e), u8(at + 0x4f)] };
  });

  const baseInstrument = (name: string): Instrument => ({
    name,
    samples: [],
    keymap: new Uint8Array(96),
    volumeEnvelope: heldEnvelope(),
    panningEnvelope: emptyEnvelope(),
    fadeout: 0,
    fadeAfterEnvelope: true,
    vibratoType: 0,
    vibratoSweep: 0,
    vibratoDepth: 0,
    vibratoRate: 0,
  });

  const applyVibrato = (instrument: Instrument, s: ItSample | null) => {
    if (!s) return;
    const [speed, depth, rate, type] = s.vibrato;
    if (!speed || !depth) return;
    instrument.vibratoRate = Math.min(63, speed);
    instrument.vibratoDepth = Math.min(15, depth >> 2);
    instrument.vibratoSweep = rate ? Math.min(255, Math.round((depth * 256) / rate / 4)) : 0;
    instrument.vibratoType = AUTO_VIBRATO_TYPES[type & 3]!;
  };

  /** Keyboard table (120 note/sample pairs at `at`) to the instrument's sample list and keymap. */
  const mapKeyboard = (instrument: Instrument, at: number) => {
    const local = new Map<number, number>();
    for (let n = 0; n < 96; n++) {
      // XM note n + 1 is IT note n + 12.
      const sampleNumber = u8(at + (n + 12) * 2 + 1);
      const s = samples[sampleNumber - 1];
      if (!s || s.sample.data.length === 0) continue;
      let index = local.get(sampleNumber);
      if (index === undefined) {
        index = instrument.samples.length;
        local.set(sampleNumber, index);
        instrument.samples.push(s.sample);
        if (index === 0) applyVibrato(instrument, s);
      }
      instrument.keymap[n] = index;
    }
  };

  const readEnvelope = (at: number, pan: boolean): Envelope | null => {
    const envFlags = u8(at);
    const count = Math.min(25, u8(at + 1));
    if (!(envFlags & 1) || count === 0) return null;
    const points = Array.from({ length: count }, (_, i) => ({
      x: u16(at + 6 + i * 3 + 1),
      y: pan ? Math.max(0, Math.min(64, s8(at + 6 + i * 3) + 32)) : Math.min(64, u8(at + 6 + i * 3)),
    }));
    for (let i = 1; i < points.length; i++) points[i]!.x = Math.max(points[i]!.x, points[i - 1]!.x);
    const clamp = (i: number) => Math.min(count - 1, i);
    return {
      enabled: true,
      points,
      loop: (envFlags & 2) !== 0,
      loopStart: clamp(u8(at + 2)),
      loopEnd: clamp(u8(at + 3)),
      sustain: (envFlags & 4) !== 0,
      sustainPoint: clamp(u8(at + 4)),
    };
  };

  let instruments: Instrument[];
  if (useInstruments) {
    instruments = instrumentOffsets.map((at) => {
      const instrument = baseInstrument(readString(bytes, at + 0x20, 26));
      if (at === 0 || readString(bytes, at, 4) !== 'IMPI') return instrument;
      mapKeyboard(instrument, at + 0x40);
      if (compatible >= 0x200) {
        instrument.fadeout = Math.min(32768, u16(at + 0x14) * 32);
        instrument.volumeEnvelope = readEnvelope(at + 0x130, false) ?? heldEnvelope();
        instrument.panningEnvelope = readEnvelope(at + 0x182, true) ?? emptyEnvelope();
      } else {
        // Instruments from IT before 2.00: fadeout in half steps, envelope as tick/value nodes.
        instrument.fadeout = Math.min(32768, u16(at + 0x18) * 64);
        const envFlags = u8(at + 0x11);
        const points: { x: number; y: number }[] = [];
        for (let i = 0; i < 25; i++) {
          const tick = u8(at + 0x1f8 + i * 2);
          if (tick === 0xff) break;
          points.push({ x: Math.max(tick, points.at(-1)?.x ?? 0), y: Math.min(64, u8(at + 0x1f9 + i * 2)) });
        }
        if (envFlags & 1 && points.length > 0) {
          const clamp = (i: number) => Math.min(points.length - 1, i);
          instrument.volumeEnvelope = {
            enabled: true,
            points,
            loop: (envFlags & 2) !== 0,
            loopStart: clamp(u8(at + 0x12)),
            loopEnd: clamp(u8(at + 0x13)),
            sustain: (envFlags & 4) !== 0,
            sustainPoint: clamp(u8(at + 0x14)),
          };
        }
      }
      return instrument;
    });
  } else {
    // Sample mode: every sample is played as its own instrument.
    instruments = samples.map((s, i) => {
      const instrument = baseInstrument(s?.sample.name ?? `Sample ${i + 1}`);
      if (s && s.sample.data.length > 0) {
        instrument.samples.push(s.sample);
        applyVibrato(instrument, s);
      }
      return instrument;
    });
  }

  // Channels in use: the highest channel any pattern writes to.
  type Event = { row: number; channel: number; note: number; ins: number; vol: number; cmd: number; info: number };
  let channels = 1;
  const parsed = patternOffsets.map((at) => {
    if (at === 0) return { rows: 64, events: [] as Event[] };
    const length = u16(at);
    const rows = Math.max(1, Math.min(256, u16(at + 2)));
    const end = Math.min(bytes.length, at + 8 + length);
    const events: Event[] = [];
    const masks = new Uint8Array(64);
    const last = Array.from({ length: 64 }, () => ({ note: 0, ins: 0, vol: 255, cmd: 0, info: 0 }));
    let p = at + 8;
    for (let row = 0; row < rows && p < end; ) {
      const channelVariable = u8(p++);
      if (channelVariable === 0) {
        row++;
        continue;
      }
      const channel = (channelVariable - 1) & 63;
      if (channelVariable & 0x80) masks[channel] = u8(p++);
      const mask = masks[channel]!;
      const prev = last[channel]!;
      const e: Event = { row, channel, note: 0, ins: 0, vol: 255, cmd: 0, info: 0 };
      if (mask & 1) prev.note = e.note = u8(p++) || 0;
      if (mask & 2) prev.ins = e.ins = u8(p++);
      if (mask & 4) prev.vol = e.vol = u8(p++);
      if (mask & 8) {
        prev.cmd = e.cmd = u8(p++);
        prev.info = e.info = u8(p++);
      }
      if (mask & 16) e.note = prev.note;
      if (mask & 32) e.ins = prev.ins;
      if (mask & 64) e.vol = prev.vol;
      if (mask & 128) {
        e.cmd = prev.cmd;
        e.info = prev.info;
      }
      // Bit 0 of the mask also marks a note of 0 (C-0), so presence is tracked by the mask.
      if (mask & 0x11) e.note += 1;
      if (channel < MAX_CHANNELS) channels = Math.max(channels, channel + 1);
      events.push(e);
    }
    return { rows, events };
  });

  const patterns: Pattern[] = parsed.map(({ rows, events }) => {
    const data = new Uint8Array(rows * channels * CELL_SIZE);
    for (const e of events) {
      if (e.channel >= channels) continue;
      const d = (e.row * channels + e.channel) * CELL_SIZE;
      let volume = 0;
      let effect: [number, number] = [0, 0];
      if (e.cmd) effect = convertEffect(e.cmd, e.info, oldEffects);
      if (e.vol !== 255) {
        const v = convertVolume(e.vol, oldEffects);
        if (v.effect && effect[0] === 0 && effect[1] === 0) effect = v.effect;
        else volume = v.volume;
      }
      // e.note is the IT note + 1, or 0 for none. IT C-5 plays at C5Speed like XM C-4 at the tuned rate.
      const note = e.note - 1;
      if (note >= 0 && note < 120) {
        data[d] = Math.max(1, Math.min(96, note - 12 + 1));
      } else if (note === 254) {
        // Note cut: silence at once through the volume column, or the effect column.
        if (volume === 0) volume = 0x10;
        else if (effect[0] === 0 && effect[1] === 0) effect = [0x0e, 0xc0];
        else data[d] = NOTE_KEY_OFF;
      } else if (note >= 120) {
        // Note off and note fade release the note.
        data[d] = NOTE_KEY_OFF;
      }
      data[d + 1] = e.ins;
      data[d + 2] = volume;
      data[d + 3] = effect[0];
      data[d + 4] = effect[1];
    }
    return { rows, data };
  });

  const channelPanning = Array.from({ length: channels }, (_, c) => {
    const pan = u8(0x40 + c) & 0x7f;
    if (!stereo || pan > 64) return 128; // mono, or surround (100)
    return Math.min(255, pan * 4);
  });

  const version = `${(createdWith >> 8) & 0x0f}.${(createdWith & 0xff).toString(16).padStart(2, '0')}`;
  return {
    format: 'xm',
    formatName: createdWith >> 12 === 0 ? `Impulse Tracker ${version} IT` : 'IT',
    title,
    channels,
    orders,
    restartPosition: 0,
    patterns,
    instruments,
    linearFrequency: linear,
    initialSpeed,
    initialTempo,
    channelPanning,
    initialGlobalVolume: globalVolume || 64,
  };
}
