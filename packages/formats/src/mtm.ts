/**
 * MultiTracker (MTM) loader. MTM stores ProTracker effects in shared tracks
 * that patterns reference per channel, with unsigned samples and a pan
 * position per channel. Notes use Amiga periods like MOD, but over a wider
 * range, so the song keeps XM semantics.
 */
import { CELL_SIZE, LoopType, type Pattern, type Sample, type Song } from '@webtracker/engine';
import { pcm8, readString, sampleInstrument } from './util.ts';

const HEADER = 66;
const SAMPLE_HEADER = 37;
const TRACK_ROWS = 64;

export function isMtm(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER && readString(bytes, 0, 3) === 'MTM' && (bytes[3] ?? 0) <= 0x10;
}

export function loadMtm(buffer: ArrayBuffer): Song {
  const bytes = new Uint8Array(buffer);
  if (!isMtm(bytes)) throw new Error('Not an MTM file');
  const u8 = (o: number) => bytes[o] ?? 0;
  const u16 = (o: number) => u8(o) | (u8(o + 1) << 8);
  const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;

  const title = readString(bytes, 4, 20);
  const numTracks = u16(24);
  const numPatterns = u8(26) + 1;
  const numOrders = u8(27) + 1;
  const commentSize = u16(28);
  const numSamples = u8(30);
  const rows = u8(32) || TRACK_ROWS;
  const channels = Math.max(1, Math.min(32, u8(33)));
  const channelPanning = Array.from({ length: channels }, (_, c) => Math.min(255, (u8(34 + c) & 0x0f) * 16 + 8));

  let o = HEADER;
  const headers = Array.from({ length: numSamples }, (_, i) => {
    const at = o + i * SAMPLE_HEADER;
    return {
      name: readString(bytes, at, 22),
      length: u32(at + 22),
      loopStart: u32(at + 26),
      loopEnd: u32(at + 30),
      // Finetune in ProTracker steps (1/8 semitone), over the whole signed byte.
      finetune: (u8(at + 34) << 24) >> 24,
      volume: Math.min(64, u8(at + 35)),
      is16: (u8(at + 36) & 1) !== 0,
    };
  });
  o += numSamples * SAMPLE_HEADER;
  const orders = Array.from(bytes.subarray(o, o + numOrders)).filter((p) => p < numPatterns);
  if (orders.length === 0) orders.push(0);
  o += 128;
  const tracksAt = o;
  o += numTracks * TRACK_ROWS * 3;
  const sequenceAt = o;
  o += numPatterns * 32 * 2;
  o += commentSize;

  const instruments = headers.map((h) => {
    const width = h.is16 ? 2 : 1;
    const frames = Math.floor(h.length / width);
    let data: Float32Array;
    if (h.is16) {
      data = new Float32Array(Math.max(0, Math.min(frames, Math.floor((bytes.length - o) / 2))));
      for (let i = 0; i < data.length; i++) data[i] = (u16(o + i * 2) - 32768) / 32768;
    } else {
      data = pcm8(bytes, o, frames, false);
    }
    o += h.length;
    // The loop ends one byte before the stored end.
    const loopStart = Math.min(Math.floor(h.loopStart / width), data.length);
    const loopEnd = Math.min(Math.floor((Math.max(h.loopEnd, 1) - 1) / width), data.length);
    const looped = loopEnd > loopStart + 4 / width;
    const fine = h.finetune * 16;
    const relativeNote = Math.round(fine / 128);
    const sample: Sample = {
      name: h.name,
      data,
      loopStart: looped ? loopStart : 0,
      loopLength: looped ? loopEnd - loopStart : 0,
      loopType: looped ? LoopType.Forward : LoopType.None,
      volume: h.volume,
      finetune: Math.max(-128, Math.min(127, fine - relativeNote * 128)),
      panning: 128,
      usePanning: false,
      relativeNote,
    };
    return sampleInstrument(h.name, sample);
  });

  const patterns: Pattern[] = Array.from({ length: numPatterns }, (_, p) => {
    const data = new Uint8Array(rows * channels * CELL_SIZE);
    for (let c = 0; c < channels; c++) {
      const track = u16(sequenceAt + (p * 32 + c) * 2);
      if (track === 0 || track > numTracks) continue;
      const at = tracksAt + (track - 1) * TRACK_ROWS * 3;
      for (let row = 0; row < rows; row++) {
        const b0 = u8(at + row * 3);
        const b1 = u8(at + row * 3 + 1);
        const b2 = u8(at + row * 3 + 2);
        const d = (row * channels + c) * CELL_SIZE;
        const note = b0 >> 2;
        // MTM note 12 is ProTracker C-1, which is C-3 here.
        if (note) data[d] = Math.min(96, note + 25);
        data[d + 1] = ((b0 & 3) << 4) | (b1 >> 4);
        let effect = b1 & 0x0f;
        let param = b2;
        // Volume slides with both nibbles set prefer the slide up, as in ProTracker.
        if (effect === 0x0a && param & 0xf0) param &= 0xf0;
        // MultiTracker has no 8xx panning and lacks some E commands.
        if (effect === 0x08 || (effect === 0x0e && [0x0, 0x3, 0x4, 0x6, 0x7, 0xf].includes(param >> 4))) effect = param = 0;
        data[d + 3] = effect;
        data[d + 4] = param;
      }
    }
    return { rows, data };
  });
  speedTempoQuirk(patterns, channels);

  return {
    format: 'xm',
    formatName: `MultiTracker ${u8(3) >> 4}.${u8(3) & 0x0f} MTM`,
    title,
    channels,
    orders,
    restartPosition: 0,
    patterns,
    instruments,
    linearFrequency: false,
    initialSpeed: 6,
    initialTempo: 125,
    channelPanning,
  };
}

/**
 * In MultiTracker a speed command also resets the tempo to 125 and a tempo
 * command the speed to 6. Many songs were written for players without that
 * quirk, so, as OpenMPT does, it only applies to songs that use both
 * commands and never on the same row.
 */
function speedTempoQuirk(patterns: Pattern[], channels: number): void {
  const kind = (pattern: Pattern, row: number) => {
    let speed = false;
    let tempo = false;
    for (let c = 0; c < channels; c++) {
      const d = (row * channels + c) * CELL_SIZE;
      if (pattern.data[d + 3] !== 0x0f || pattern.data[d + 4] === 0) continue;
      if (pattern.data[d + 4]! < 32) speed = true;
      else tempo = true;
    }
    return { speed, tempo };
  };
  let anySpeed = false;
  let anyTempo = false;
  for (const pattern of patterns) {
    for (let row = 0; row < pattern.rows; row++) {
      const k = kind(pattern, row);
      if (k.speed && k.tempo) return;
      anySpeed ||= k.speed;
      anyTempo ||= k.tempo;
    }
  }
  if (!anySpeed || !anyTempo) return;
  for (const pattern of patterns) {
    for (let row = 0; row < pattern.rows; row++) {
      const k = kind(pattern, row);
      if (!k.speed && !k.tempo) continue;
      // The partner command goes into a free effect slot on the same row.
      for (let c = 0; c < channels; c++) {
        const d = (row * channels + c) * CELL_SIZE;
        if (pattern.data[d + 3] !== 0 || pattern.data[d + 4] !== 0) continue;
        pattern.data[d + 3] = 0x0f;
        pattern.data[d + 4] = k.speed ? 125 : 6;
        break;
      }
    }
  }
}
