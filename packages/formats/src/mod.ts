import {
  CELL_SIZE,
  LoopType,
  NOTE_NONE,
  emptyEnvelope,
  type Instrument,
  type Pattern,
  type Sample,
  type Song,
} from '@webtracker/engine';
import { readString } from './util.ts';

/** Panning used for the Amiga's hard left/right channels (0..255, 128 = centre). */
const AMIGA_LEFT = 64;
const AMIGA_RIGHT = 192;

function channelsFromTag(tag: string): number {
  switch (tag) {
    case 'M.K.':
    case 'M!K!':
    case 'M&K!':
    case 'N.T.':
    case 'FLT4':
    case '4CHN':
    case 'FEST':
    case 'NSMS':
    case 'LARD':
      return 4;
    case 'FLT8':
    case 'OCTA':
    case 'OKTA':
    case 'CD81':
      return 8;
  }
  let m = /^(\d)CHN$/.exec(tag);
  if (m) return Number(m[1]);
  m = /^(\d\d)C[HN]$/.exec(tag);
  if (m) return Number(m[1]);
  m = /^TDZ(\d)$/.exec(tag);
  if (m) return Number(m[1]);
  return 0;
}

/** Amiga period to XM note number (1..96), with period 428 being C-4. */
export function periodToNote(period: number): number {
  if (period <= 0) return NOTE_NONE;
  const note = Math.round(12 * Math.log2(428 / period)) + 49;
  return Math.max(1, Math.min(96, note));
}

export function isMod(bytes: Uint8Array): boolean {
  if (bytes.length < 1084) return false;
  return channelsFromTag(readString(bytes, 1080, 4)) > 0;
}

export function loadMod(buffer: ArrayBuffer): Song {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 600) throw new Error('File too small to be a MOD');

  const tag = bytes.length >= 1084 ? String.fromCharCode(...bytes.subarray(1080, 1084)) : '';
  let channels = channelsFromTag(tag);
  // Original Soundtracker modules have 15 samples and no tag.
  const numSamples = channels > 0 ? 31 : 15;
  if (channels === 0) channels = 4;
  if (channels < 1 || channels > 32) throw new Error(`Unsupported channel count ${channels}`);

  const title = readString(bytes, 0, 20);
  const u8 = (o: number) => bytes[o] ?? 0;
  const word = (o: number) => (u8(o) << 8) | u8(o + 1);

  const headers: { name: string; length: number; finetune: number; volume: number; loopStart: number; loopLength: number }[] = [];
  for (let i = 0; i < numSamples; i++) {
    const o = 20 + i * 30;
    const ft = u8(o + 24) & 0x0f;
    headers.push({
      name: readString(bytes, o, 22),
      length: word(o + 22) * 2,
      finetune: ft > 7 ? ft - 16 : ft,
      volume: Math.min(64, u8(o + 25)),
      loopStart: word(o + 26) * 2,
      loopLength: word(o + 28) * 2,
    });
  }

  let o = 20 + numSamples * 30;
  const songLength = Math.max(1, Math.min(128, u8(o)));
  const restartByte = u8(o + 1);
  const orderTable = Array.from(bytes.subarray(o + 2, o + 130));
  o += 130 + (numSamples === 31 ? 4 : 0);

  // All 128 order entries count when determining the pattern count, like ProTracker does.
  const numPatterns = Math.max(...orderTable) + 1;
  const orders = orderTable.slice(0, songLength);

  const patterns: Pattern[] = [];
  for (let p = 0; p < numPatterns; p++) {
    const data = new Uint8Array(64 * channels * CELL_SIZE);
    for (let row = 0; row < 64; row++) {
      for (let ch = 0; ch < channels; ch++) {
        const src = o + (row * channels + ch) * 4;
        if (src + 4 > bytes.length) continue;
        const b0 = u8(src), b1 = u8(src + 1), b2 = u8(src + 2), b3 = u8(src + 3);
        const period = ((b0 & 0x0f) << 8) | b1;
        const instrument = (b0 & 0xf0) | (b2 >> 4);
        let effect = b2 & 0x0f;
        let param = b3;
        // E0x (Amiga LED filter) has no meaning here, F00 (stop) is ignored.
        if ((effect === 0x0e && param >> 4 === 0) || (effect === 0x0f && param === 0)) {
          effect = 0;
          param = 0;
        }
        const d = (row * channels + ch) * CELL_SIZE;
        data[d] = periodToNote(period);
        data[d + 1] = instrument;
        data[d + 2] = 0;
        data[d + 3] = effect;
        data[d + 4] = param;
      }
    }
    patterns.push({ rows: 64, data });
    o += 64 * channels * 4;
  }

  const instruments: Instrument[] = headers.map((h) => {
    const available = Math.max(0, Math.min(h.length, bytes.length - o));
    const data = new Float32Array(available);
    for (let i = 0; i < available; i++) data[i] = ((u8(o + i) << 24) >> 24) / 128;
    o += h.length;

    let loopStart = Math.min(h.loopStart, available);
    let loopLength = Math.min(h.loopLength, available - loopStart);
    const looped = h.loopLength > 2 && loopLength > 2;
    if (!looped) {
      loopStart = 0;
      loopLength = 0;
    }

    const sample: Sample = {
      name: h.name,
      data,
      loopStart,
      loopLength,
      loopType: looped ? LoopType.Forward : LoopType.None,
      volume: h.volume,
      finetune: h.finetune * 16,
      panning: 128,
      relativeNote: 0,
    };
    return {
      name: h.name,
      samples: available > 0 ? [sample] : [],
      keymap: new Uint8Array(96),
      volumeEnvelope: emptyEnvelope(),
      panningEnvelope: emptyEnvelope(),
      fadeout: 0,
      vibratoType: 0,
      vibratoSweep: 0,
      vibratoDepth: 0,
      vibratoRate: 0,
    };
  });

  const channelPanning: number[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const m = ch & 3;
    channelPanning.push(m === 0 || m === 3 ? AMIGA_LEFT : AMIGA_RIGHT);
  }

  return {
    format: 'mod',
    formatName: numSamples === 15 ? 'Soundtracker (15 samples)' : `ProTracker-compatible ${tag.trim()}`,
    title,
    channels,
    orders,
    restartPosition: restartByte < songLength ? restartByte : 0,
    patterns,
    instruments,
    linearFrequency: false,
    initialSpeed: 6,
    initialTempo: 125,
    channelPanning,
  };
}
