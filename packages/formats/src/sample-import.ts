import { emptyInstrument, emptySample, LoopType, tuningForRate, type Instrument, type Sample } from '@webtracker/engine';
import { readString } from './util.ts';
import { Reader, readInstrumentFields, readSamples } from './xm.ts';

/** What an imported file turned into. */
export type Imported = { kind: 'sample'; sample: Sample; rate: number } | { kind: 'instrument'; instrument: Instrument };

const ascii = (bytes: Uint8Array, o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));

/** Mixes interleaved channels down to mono. */
function mono(frames: number, channels: number, read: (frame: number, channel: number) => number): Float32Array {
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(f, c);
    out[f] = sum / channels;
  }
  return out;
}

/** A sample named after the file, tuned so it plays at its own rate on C-4. */
function tunedSample(name: string, data: Float32Array, rate: number): Sample {
  const sample = emptySample(name.replace(/\.[^.]+$/, '').slice(0, 22));
  sample.data = data;
  Object.assign(sample, tuningForRate(rate));
  return sample;
}

// ---- WAV ------------------------------------------------------------------

export function isWav(b: Uint8Array): boolean {
  return b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE';
}

export function loadWav(buffer: ArrayBuffer, name = ''): Imported {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  let format = 0;
  let channels = 1;
  let rate = 8363;
  let bits = 16;
  let data: { at: number; size: number } | null = null;
  let loop: { start: number; end: number; type: number } | null = null;

  for (let o = 12; o + 8 <= b.length; ) {
    const id = ascii(b, o, 4);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      rate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the sub-format GUID.
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { at: body, size: Math.min(size, b.length - body) };
    } else if (id === 'smpl' && size >= 36 + 24 && v.getUint32(body + 28, true) > 0) {
      const l = body + 36;
      loop = { type: v.getUint32(l + 4, true), start: v.getUint32(l + 8, true), end: v.getUint32(l + 12, true) };
    }
    o = body + size + (size & 1);
  }

  if (!data) throw new Error('WAV file has no data chunk');
  if (format !== 1 && format !== 3) throw new Error(`WAV format ${format} is not supported (PCM or float only)`);
  if (channels < 1) throw new Error('WAV file has no channels');
  const bytesPer = bits / 8;
  const frames = Math.floor(data.size / (bytesPer * channels));
  const at = data.at;
  const read = (f: number, c: number): number => {
    const o = at + (f * channels + c) * bytesPer;
    if (format === 3) return bits === 64 ? v.getFloat64(o, true) : v.getFloat32(o, true);
    switch (bits) {
      case 8:
        return (b[o]! - 128) / 128;
      case 16:
        return v.getInt16(o, true) / 32768;
      case 24:
        return ((b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) << 8 >> 8) / 8388608;
      case 32:
        return v.getInt32(o, true) / 2147483648;
    }
    throw new Error(`${bits}-bit WAV is not supported`);
  };

  const sample = tunedSample(name, mono(frames, channels, read), rate);
  if (loop && loop.end > loop.start && loop.start < frames) {
    sample.loopType = loop.type === 1 ? LoopType.PingPong : LoopType.Forward;
    sample.loopStart = loop.start;
    // The smpl chunk's end frame is inclusive.
    sample.loopLength = Math.min(frames, loop.end + 1) - loop.start;
  }
  return { kind: 'sample', sample, rate };
}

// ---- AIFF -----------------------------------------------------------------

export function isAiff(b: Uint8Array): boolean {
  return b.length >= 12 && ascii(b, 0, 4) === 'FORM' && (ascii(b, 8, 4) === 'AIFF' || ascii(b, 8, 4) === 'AIFC');
}

/** 80-bit IEEE extended float, as AIFF stores the sample rate. */
function extended(v: DataView, o: number): number {
  const exp = v.getUint16(o) & 0x7fff;
  const hi = v.getUint32(o + 2);
  const lo = v.getUint32(o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

export function loadAiff(buffer: ArrayBuffer, name = ''): Imported {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  const aifc = ascii(b, 8, 4) === 'AIFC';
  let channels = 1;
  let frames = 0;
  let bits = 16;
  let rate = 8363;
  let little = false;
  let data = -1;

  for (let o = 12; o + 8 <= b.length; ) {
    const id = ascii(b, o, 4);
    const size = v.getUint32(o + 4);
    const body = o + 8;
    if (id === 'COMM') {
      channels = v.getUint16(body);
      frames = v.getUint32(body + 2);
      bits = v.getUint16(body + 6);
      rate = extended(v, body + 8);
      if (aifc) {
        const compression = ascii(b, body + 18, 4);
        if (compression === 'sowt') little = true;
        else if (compression !== 'NONE') throw new Error(`Compressed AIFF (${compression}) is not supported`);
      }
    } else if (id === 'SSND') {
      data = body + 8 + v.getUint32(body);
    }
    o = body + size + (size & 1);
  }
  if (data < 0 || channels < 1) throw new Error('AIFF file has no sound data');
  const bytesPer = Math.ceil(bits / 8);
  frames = Math.min(frames, Math.floor((b.length - data) / (bytesPer * channels)));
  const read = (f: number, c: number): number => {
    const o = data + (f * channels + c) * bytesPer;
    switch (bytesPer) {
      case 1:
        return v.getInt8(o) / 128;
      case 2:
        return v.getInt16(o, little) / 32768;
      case 3: {
        const x = little ? b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) : (b[o]! << 16) | (b[o + 1]! << 8) | b[o + 2]!;
        return ((x << 8) >> 8) / 8388608;
      }
      default:
        return v.getInt32(o, little) / 2147483648;
    }
  };
  return { kind: 'sample', sample: tunedSample(name, mono(frames, channels, read), rate), rate };
}

// ---- IFF 8SVX -------------------------------------------------------------

export function is8svx(b: Uint8Array): boolean {
  return b.length >= 12 && ascii(b, 0, 4) === 'FORM' && ascii(b, 8, 4) === '8SVX';
}

export function load8svx(buffer: ArrayBuffer, name = ''): Imported {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  let oneShot = 0;
  let repeat = 0;
  let rate = 8363;
  let title = '';
  let body: Uint8Array | null = null;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = ascii(b, o, 4);
    const size = v.getUint32(o + 4);
    const at = o + 8;
    if (id === 'VHDR') {
      oneShot = v.getUint32(at);
      repeat = v.getUint32(at + 4);
      rate = v.getUint16(at + 12) || 8363;
      if (b[at + 15] !== 0) throw new Error('Compressed 8SVX is not supported');
    } else if (id === 'NAME') {
      title = readString(b, at, size);
    } else if (id === 'BODY') {
      body = b.subarray(at, Math.min(b.length, at + size));
    }
    o = at + size + (size & 1);
  }
  if (!body) throw new Error('8SVX file has no BODY chunk');
  const data = Float32Array.from(body, (x) => ((x << 24) >> 24) / 128);
  const sample = tunedSample(title || name, data, rate);
  if (repeat > 0 && oneShot < data.length) {
    sample.loopType = LoopType.Forward;
    sample.loopStart = oneShot;
    sample.loopLength = Math.min(repeat, data.length - oneShot);
  }
  return { kind: 'sample', sample, rate };
}

// ---- XI (FastTracker 2 instrument) ----------------------------------------

const XI_ID = 'Extended Instrument: ';

export function isXi(b: Uint8Array): boolean {
  return b.length >= 298 && ascii(b, 0, 21) === XI_ID;
}

export function loadXi(buffer: ArrayBuffer): Imported {
  const r = new Reader(new Uint8Array(buffer));
  const instrument = emptyInstrument(readString(r.bytes, 21, 22));
  // Same fields as an XM instrument header, starting at the keymap.
  readInstrumentFields(r, instrument, 66);
  const count = Math.min(16, r.u16(296));
  instrument.samples = readSamples(r, 298, count, 40).samples;
  return { kind: 'instrument', instrument };
}

// ---- PAT (Gravis UltraSound patch) -----------------------------------------

const PAT_HEADER = 239;
const PAT_SAMPLE = 96;

export function isPat(b: Uint8Array): boolean {
  return b.length >= PAT_HEADER && (ascii(b, 0, 12) === 'GF1PATCH110\0' || ascii(b, 0, 12) === 'GF1PATCH100\0');
}

/** Frequency of note index 0..95 (C-0..B-7) in Hz, with C-4 at middle C. */
const noteHz = (index: number) => 261.6256 * Math.pow(2, (index - 48) / 12);

/**
 * Reads a Gravis patch as an instrument: one sample per wave, mapped to the
 * keys of its frequency range and tuned from its root frequency. The patch
 * envelopes are left out.
 */
export function loadPat(buffer: ArrayBuffer, name = ''): Imported {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  const instrument = emptyInstrument(readString(b, 131, 16) || name.replace(/\.[^.]+$/, '').slice(0, 22));
  const count = Math.min(16, b[198] ?? 0);
  type Range = { low: number; high: number; root: number };
  const ranges: Range[] = [];
  let o = PAT_HEADER;
  for (let i = 0; i < count && o + PAT_SAMPLE <= b.length; i++) {
    const size = v.getUint32(o + 8, true);
    const loopStart = v.getUint32(o + 12, true);
    const loopEnd = v.getUint32(o + 16, true);
    const rate = v.getUint16(o + 20, true) || 44100;
    const low = v.getUint32(o + 22, true);
    const high = v.getUint32(o + 26, true);
    const root = v.getUint32(o + 30, true) || 261626;
    const modes = b[o + 55] ?? 0;
    const sixteen = (modes & 1) !== 0;
    const unsigned = (modes & 2) !== 0;
    const width = sixteen ? 2 : 1;
    const at = o + PAT_SAMPLE;
    const frames = Math.floor(Math.min(size, b.length - at) / width);
    const data = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      data[f] = sixteen
        ? ((unsigned ? v.getUint16(at + f * 2, true) - 32768 : v.getInt16(at + f * 2, true)) / 32768)
        : ((unsigned ? b[at + f]! - 128 : (b[at + f]! << 24) >> 24) / 128);
    }
    if (modes & 16) data.reverse();
    // The patch plays its root frequency at the stored rate; C-4 plays middle C.
    const sample = tunedSample(readString(b, o, 7) || `${instrument.name} ${i + 1}`, data, (rate * noteHz(48) * 1000) / root);
    const start = Math.min(frames, Math.floor(loopStart / width));
    const end = Math.min(frames, Math.floor(loopEnd / width));
    if (modes & 4 && end > start) {
      sample.loopStart = start;
      sample.loopLength = end - start;
      sample.loopType = modes & 8 ? LoopType.PingPong : LoopType.Forward;
    }
    instrument.samples.push(sample);
    ranges.push({ low, high, root });
    o = at + size;
  }
  if (instrument.samples.length === 0) throw new Error('PAT file has no waves');
  // Each key takes the wave whose range holds it, else the one with the nearest root.
  for (let n = 0; n < 96; n++) {
    const milliHz = noteHz(n) * 1000;
    let pick = ranges.findIndex((r) => milliHz >= r.low && milliHz <= r.high);
    if (pick < 0) {
      let best = Infinity;
      ranges.forEach((r, i) => {
        const distance = Math.abs(Math.log(milliHz / r.root));
        if (distance < best) [best, pick] = [distance, i];
      });
    }
    instrument.keymap[n] = Math.max(0, pick);
  }
  return { kind: 'instrument', instrument };
}

// ---- Raw PCM -----------------------------------------------------------------

export type RawFormat = 's8' | 'u8' | 's16le' | 's16be';

/** Headerless sample data in the given format, tuned to play at `rate` on C-4. */
export function loadRaw(buffer: ArrayBuffer, name = '', format: RawFormat = 's8', rate = 8363): Imported {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  const sixteen = format === 's16le' || format === 's16be';
  const frames = sixteen ? b.length >> 1 : b.length;
  const data = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (format === 's8') data[f] = ((b[f]! << 24) >> 24) / 128;
    else if (format === 'u8') data[f] = (b[f]! - 128) / 128;
    else data[f] = v.getInt16(f * 2, format === 's16le') / 32768;
  }
  return { kind: 'sample', sample: tunedSample(name, data, rate), rate };
}

/**
 * Reads a sample or instrument file it understands by its contents: WAV,
 * AIFF, IFF 8SVX, XI or a Gravis PAT. Returns null for anything else, so the caller can
 * hand it to the browser's decoder (MP3, OGG, FLAC).
 */
export function importSample(buffer: ArrayBuffer, name = ''): Imported | null {
  const b = new Uint8Array(buffer);
  if (isWav(b)) return loadWav(buffer, name);
  if (isAiff(b)) return loadAiff(buffer, name);
  if (is8svx(b)) return load8svx(buffer, name);
  if (isXi(b)) return loadXi(buffer);
  if (isPat(b)) return loadPat(buffer, name);
  return null;
}

/** Wraps decoded audio (for example from decodeAudioData) as a tuned sample. */
export function sampleFromChannels(channels: Float32Array[], rate: number, name = ''): Sample {
  const frames = Math.min(...channels.map((c) => c.length));
  return tunedSample(name, mono(frames, channels.length, (f, c) => channels[c]![f]!), rate);
}
