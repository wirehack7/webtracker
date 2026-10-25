/**
 * Composer 669 and UNIS 669 loader. 669 songs have eight channels, 64-row
 * patterns with a per-pattern speed and break row, unsigned samples and a
 * small effect set. They play with Amiga periods at a fixed tempo.
 */
import { CELL_SIZE, LoopType, type Pattern, type Sample, type Song } from '@webtracker/engine';
import { pcm8, readString, sampleInstrument } from './util.ts';

const CHANNELS = 8;
const ROWS = 64;
const HEADER = 0x1f1;
const SAMPLE_HEADER = 25;

export function is669(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER) return false;
  const magic = readString(bytes, 0, 2);
  if (magic !== 'if' && magic !== 'JN') return false;
  const samples = bytes[110] ?? 0;
  const patterns = bytes[111] ?? 0;
  return samples <= 64 && patterns > 0 && patterns <= 128 && (bytes[112] ?? 0) < 128;
}

/** Amiga period times frequency: the XM-shaped model plays period P at AMIGA / P Hz. */
const AMIGA = 8363 * 428;

/**
 * 669 effect nibble and parameter to an XM effect and parameter, for the
 * effects that do not depend on the pitch. Slides are converted by the
 * loader itself, see {@link slideRows}.
 */
export function convertEffect(command: number, param: number, extended: boolean): [number, number] {
  switch (command) {
    case 4: // vibrato with equal speed and depth
      return [0x04, param * 17];
    case 5: // ticks per row
      return param ? [0x0f, param] : [0, 0];
    case 7: // UNIS 669 retrigger
      return extended ? [0x1b, param] : [0, 0];
  }
  // 3 (frequency adjust) and the UNIS 669 panning slide have no XM form.
  return [0, 0];
}

type Slide = { kind: 0 | 1 | 2; rate: number; target: number };

/**
 * 669 slides change the sample rate by a fixed number of Hertz on every tick
 * and keep going on later rows until the next note or effect. The loader
 * follows each channel's rate through the pattern and writes, on every row
 * the slide covers, the period slide that reaches the same rate at the end
 * of that row.
 */
function slideRows(data: Uint8Array, rows: number, raw: (row: number, c: number) => [number, number], speed: number): void {
  const freq = new Float64Array(CHANNELS);
  const slides: (Slide | null)[] = Array.from({ length: CHANNELS }, () => null);
  for (let row = 0; row < rows; row++) {
    for (let c = 0; c < CHANNELS; c++) {
      const [, b2] = raw(row, c);
      if (b2 !== 0xff && b2 >> 4 === 5 && (b2 & 0x0f) > 0) speed = b2 & 0x0f;
    }
    for (let c = 0; c < CHANNELS; c++) {
      const [b0, b2] = raw(row, c);
      const d = (row * CHANNELS + c) * CELL_SIZE;
      const command = b2 === 0xff ? -1 : b2 >> 4;
      const param = b2 & 0x0f;
      if (b0 < 0xfe) {
        const noteFreq = 8363 * Math.pow(2, ((data[d] ?? 49) - 49) / 12);
        if (command === 2 && freq[c]) {
          // With the tone portamento the note is only the target, as in XM.
          slides[c] = { kind: 2, rate: param * 40, target: noteFreq };
        } else {
          freq[c] = noteFreq;
          slides[c] = null;
        }
      }
      if (command === 0 || command === 1) slides[c] = { kind: command, rate: param * 80, target: 0 };
      else if (command === 2 && b0 >= 0xfe && slides[c]?.kind === 2) slides[c]!.rate = param * 40;
      else if (command > 2) slides[c] = null;

      const slide = slides[c];
      if (!slide || !freq[c] || data[d + 3] || data[d + 4]) continue;
      // The slide runs on every tick of the row.
      const from = freq[c]!;
      let to = slide.kind === 1 ? from - slide.rate * speed : from + (slide.kind === 0 ? slide.rate * speed : 0);
      if (slide.kind === 2) to = from < slide.target ? Math.min(slide.target, from + slide.rate * speed) : Math.max(slide.target, from - slide.rate * speed);
      to = Math.max(1, to);
      const ticks = Math.max(1, speed - 1);
      const units = Math.min(255, Math.max(1, Math.round(Math.abs(AMIGA / to - AMIGA / from) / ticks)));
      if (slide.kind === 2) {
        data[d + 3] = 0x03;
        data[d + 4] = units;
      } else {
        data[d + 3] = to > from ? 0x01 : 0x02;
        data[d + 4] = units;
      }
      // Follow what the player will reach, so rounding does not add up.
      const period = AMIGA / from + (to > from ? -units : units) * ticks;
      freq[c] = slide.kind === 2 && Math.abs(to - slide.target) < 1e-6 ? slide.target : AMIGA / Math.max(1, period);
      if (slide.kind === 2 && freq[c] === slide.target) slides[c] = null;
      if (slide.kind === 1 && to <= 1) slides[c] = null;
    }
  }
}

export function load669(buffer: ArrayBuffer): Song {
  const bytes = new Uint8Array(buffer);
  if (!is669(bytes)) throw new Error('Not a 669 file');
  const u8 = (o: number) => bytes[o] ?? 0;
  const u32 = (o: number) => (u8(o) | (u8(o + 1) << 8) | (u8(o + 2) << 16) | (u8(o + 3) << 24)) >>> 0;

  const unis = readString(bytes, 0, 2) === 'JN';
  const title = readString(bytes, 2, 36);
  const numSamples = u8(110);
  const numPatterns = u8(111);
  const restart = u8(112);
  const orders: number[] = [];
  for (let i = 0; i < 128; i++) {
    const p = u8(113 + i);
    if (p === 0xff) break;
    if (p < numPatterns) orders.push(p);
  }
  if (orders.length === 0) orders.push(0);

  let o = HEADER;
  const headers = Array.from({ length: numSamples }, (_, i) => {
    const at = o + i * SAMPLE_HEADER;
    return { name: readString(bytes, at, 13), length: u32(at + 13), loopStart: u32(at + 17), loopEnd: u32(at + 21) };
  });
  o += numSamples * SAMPLE_HEADER;

  const patterns: Pattern[] = Array.from({ length: numPatterns }, (_, p) => {
    const at = o + p * ROWS * CHANNELS * 3;
    const breakRow = Math.min(ROWS - 1, u8(369 + p));
    const rows = breakRow + 1;
    const data = new Uint8Array(rows * CHANNELS * CELL_SIZE);
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < CHANNELS; c++) {
        const src = at + (row * CHANNELS + c) * 3;
        const b0 = u8(src);
        const b1 = u8(src + 1);
        const b2 = u8(src + 2);
        const d = (row * CHANNELS + c) * CELL_SIZE;
        if (b0 < 0xfe) {
          data[d] = Math.min(96, (b0 >> 2) + 25);
          data[d + 1] = (((b0 & 3) << 4) | (b1 >> 4)) + 1;
        }
        if (b0 !== 0xff) data[d + 2] = 0x10 + Math.floor(((b1 & 0x0f) * 64 + 8) / 15);
        // Retrigger only acts together with a note.
        if (b2 !== 0xff && (b2 >> 4 !== 7 || b0 < 0xfe)) [data[d + 3], data[d + 4]] = convertEffect(b2 >> 4, b2 & 0x0f, unis);
      }
    }
    slideRows(data, rows, (row, c) => [u8(at + (row * CHANNELS + c) * 3), u8(at + (row * CHANNELS + c) * 3 + 2)], u8(241 + p) || 4);
    // Each pattern starts at its own speed, in the first free effect slot of row 0.
    const speed = u8(241 + p);
    for (let c = 0; c < CHANNELS; c++) {
      const d = c * CELL_SIZE;
      if (data[d + 3] === 0 && data[d + 4] === 0) {
        data[d + 3] = 0x0f;
        data[d + 4] = Math.max(1, Math.min(31, speed));
        break;
      }
    }
    return { rows, data };
  });
  o += numPatterns * ROWS * CHANNELS * 3;

  const instruments = headers.map((h) => {
    const data = pcm8(bytes, o, h.length, false);
    o += h.length;
    // A loop end past the sample with a loop start of 0 means no loop.
    const loopEnd = Math.min(h.loopEnd, data.length);
    const loopStart = Math.min(h.loopStart, data.length);
    const looped = !(h.loopEnd > h.length && h.loopStart === 0) && loopEnd > loopStart + 1;
    const sample: Sample = {
      name: h.name,
      data,
      loopStart: looped ? loopStart : 0,
      loopLength: looped ? loopEnd - loopStart : 0,
      loopType: looped ? LoopType.Forward : LoopType.None,
      volume: 64,
      finetune: 0,
      panning: 128,
      usePanning: false,
      relativeNote: 0,
    };
    return sampleInstrument(h.name, sample);
  });

  return {
    format: 'xm',
    formatName: unis ? 'UNIS 669' : 'Composer 669',
    title,
    channels: CHANNELS,
    orders,
    restartPosition: restart < orders.length ? restart : 0,
    patterns,
    instruments,
    linearFrequency: false,
    initialSpeed: 4,
    initialTempo: 78,
    channelPanning: Array.from({ length: CHANNELS }, (_, c) => (c & 1 ? 0xd0 : 0x30)),
  };
}
