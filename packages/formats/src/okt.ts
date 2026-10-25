/**
 * Oktalyzer (OKT) loader. Oktalyzer is an Amiga tracker that splits some of
 * the four hardware channels in two for up to eight voices. The file is an
 * IFF-style chunk list; notes and effects map to ProTracker semantics, so
 * the song plays as MOD.
 */
import { CELL_SIZE, LoopType, NOTE_KEY_OFF, tuningForRate, type Pattern, type Sample, type Song } from '@webtracker/engine';
import { pcm8, readString, sampleInstrument } from './util.ts';

const AMIGA_LEFT = 64;
const AMIGA_RIGHT = 192;

export function isOkt(bytes: Uint8Array): boolean {
  return bytes.length >= 16 && readString(bytes, 0, 8) === 'OKTASONG';
}

/** Arpeggio 1 and 2 play notes below the base note; ProTracker can only go up, so they wrap by an octave. */
function invertArpeggio(n: number): number {
  n &= 0x0f;
  return n === 0 ? 0 : n <= 12 ? 12 - n : 24 - n;
}

/** Oktalyzer effect number and parameter to a ProTracker effect and parameter. */
export function convertEffect(command: number, param: number): [number, number] {
  const x = param >> 4;
  const y = param & 0x0f;
  switch (command) {
    case 1: // portamento down in period, so the pitch goes up
      return param ? [0x01, param] : [0, 0];
    case 2: // portamento up in period, the pitch goes down
      return param ? [0x02, param] : [0, 0];
    case 10: // arpeggio 1: down, base, up
      return param ? [0x00, (invertArpeggio(x) << 4) | y] : [0, 0];
    case 11: // arpeggio 2: base, up, base, down
      return param ? [0x00, (param & 0xf0) | invertArpeggio(y)] : [0, 0];
    case 12: // arpeggio 3: up, up, base
      return param ? [0x00, param] : [0, 0];
    case 15: // Amiga filter: any value other than 0 turns it on
      return [0x0e, param ? 0x00 : 0x01];
    case 25: // position jump
      return [0x0b, param];
    case 28: // speed
      return param && param < 0x20 ? [0x0f, param] : [0, 0];
    case 31: // volume: set 0..40, slide down 4x and up 5x per tick, fine down 6x and up 7x per row
      if (param <= 0x40) return [0x0c, param];
      if (x === 4) return [0x0a, y];
      if (x === 5) return [0x0a, y << 4];
      if (x === 6) return [0x0e, 0xb0 | Math.min(14, y)];
      if (x === 7) return [0x0e, 0xa0 | Math.min(14, y)];
      return [0, 0];
  }
  // Note slides (13, 17, 21, 30) have no ProTracker form.
  return [0, 0];
}

/** Volume command on a paired channel as a channel volume effect (Mxx, Nxy). */
function pairedVolume(param: number): [number, number] | null {
  const x = param >> 4;
  const y = param & 0x0f;
  if (param <= 0x40) return [0x16, param];
  if (x === 4) return [0x17, y];
  if (x === 5) return [0x17, y << 4];
  if (x === 6) return [0x17, 0xf0 | Math.min(14, y)];
  if (x === 7) return [0x17, (Math.min(14, y) << 4) | 0x0f];
  return null;
}

export function loadOkt(buffer: ArrayBuffer): Song {
  const bytes = new Uint8Array(buffer);
  if (!isOkt(bytes)) throw new Error('Not an Oktalyzer file');
  const u8 = (o: number) => bytes[o] ?? 0;
  const u16 = (o: number) => (u8(o) << 8) | u8(o + 1);
  const u32 = (o: number) => ((u16(o) << 16) | u16(o + 2)) >>> 0;

  // Hardware channel split flags, then the per-voice panning that follows from them.
  let split = [0, 0, 0, 0];
  type SampleHeader = { name: string; length: number; loopStart: number; loopLength: number; volume: number; type: number };
  let headers: SampleHeader[] = [];
  let speed = 6;
  let numPatterns = 0;
  let songLength = 0;
  let rawOrders: number[] = [];
  const patternChunks: [number, number][] = [];
  const sampleChunks: [number, number][] = [];

  for (let o = 8; o + 8 <= bytes.length; ) {
    const id = readString(bytes, o, 4);
    const size = u32(o + 4);
    const at = o + 8;
    const end = Math.min(bytes.length, at + size);
    switch (id) {
      case 'CMOD':
        split = [0, 1, 2, 3].map((i) => u16(at + i * 2) & 1);
        break;
      case 'SAMP':
        headers = [];
        for (let s = at; s + 32 <= end; s += 32) {
          headers.push({
            name: readString(bytes, s, 20),
            length: u32(s + 20) & ~1,
            loopStart: u16(s + 24) * 2,
            loopLength: u16(s + 26) * 2,
            volume: Math.min(64, u16(s + 28)),
            // 0: 7-bit, only on paired channels; 1: 8-bit, only on single channels; 2: both.
            type: u16(s + 30),
          });
        }
        break;
      case 'SPEE':
        speed = u16(at) || 6;
        break;
      case 'SLEN':
        numPatterns = u16(at);
        break;
      case 'PLEN':
        songLength = u16(at);
        break;
      case 'PATT':
        rawOrders = Array.from(bytes.subarray(at, end));
        break;
      case 'PBOD':
        patternChunks.push([at, end]);
        break;
      case 'SBOD':
        sampleChunks.push([at, end]);
        break;
    }
    o = at + size;
  }

  // Each split hardware channel becomes a pair of voices on the same side.
  const channelPanning: number[] = [];
  const paired: boolean[] = [];
  const first: boolean[] = [];
  split.forEach((s, hw) => {
    const pan = hw === 0 || hw === 3 ? AMIGA_LEFT : AMIGA_RIGHT;
    for (let i = 0; i <= s; i++) {
      channelPanning.push(pan);
      paired.push(s !== 0);
      first.push(i === 0);
    }
  });
  const channels = channelPanning.length;
  // Samples of type 2 played on a paired channel lose their loop there; they use a copy at +36.
  const unloopedCopies = new Set<number>();

  const patterns: Pattern[] = patternChunks.slice(0, numPatterns || patternChunks.length).map(([at, end]) => {
    const rows = Math.max(1, Math.min(256, u16(at)));
    const data = new Uint8Array(rows * channels * CELL_SIZE);
    const pairWrites: [number, [number, number]][] = [];
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < channels; c++) {
        const src = at + 2 + (row * channels + c) * 4;
        if (src + 4 > end) continue;
        const d = (row * channels + c) * CELL_SIZE;
        const note = u8(src);
        const command = u8(src + 2);
        const param = u8(src + 3);
        // Oktalyzer notes 1..36 are ProTracker C-1..B-3, which start at C-3 here.
        if (note > 0 && note <= 36) {
          let instrument = u8(src + 1) + 1;
          const h = headers[instrument - 1];
          // A sample whose type does not fit the channel stays silent.
          if (h && ((h.type === 1 && paired[c]) || (h.type === 0 && !paired[c]))) instrument = 0;
          if (h && h.type === 2 && paired[c] && h.loopLength > 2) {
            unloopedCopies.add(instrument - 1);
            instrument += 36;
          }
          if (instrument) {
            // Paired voices reach up to A#-4 and always start at full volume.
            data[d] = paired[c] ? Math.min(70, note + 36) : note + 36;
            data[d + 1] = instrument;
            if (paired[c]) data[d + 2] = 0x50;
          }
        }
        if (command === 27) {
          // Release: the sample leaves its loop and plays out, which here ends the note.
          data[d] = NOTE_KEY_OFF;
          data[d + 1] = 0;
        } else if (command === 31 && paired[c]) {
          // On a paired channel the volume command sets the hardware channel, so both voices follow.
          const volume = pairedVolume(param);
          if (volume) {
            [data[d + 3], data[d + 4]] = volume;
            pairWrites.push([first[c] ? c + 1 : c - 1, volume]);
          }
        } else if (command === 31 && param <= 0x40) {
          data[d + 2] = 0x10 + param;
        } else {
          [data[d + 3], data[d + 4]] = convertEffect(command, param);
        }
      }
      for (const [c, [effect, param]] of pairWrites.splice(0)) {
        const d = (row * channels + c) * CELL_SIZE;
        if (data[d + 3] === 0 && data[d + 4] === 0) {
          data[d + 3] = effect;
          data[d + 4] = param;
        }
      }
    }
    return { rows, data };
  });
  if (patterns.length === 0) patterns.push({ rows: 64, data: new Uint8Array(64 * channels * CELL_SIZE) });

  // Sample bodies follow in order for the samples that have data.
  let body = 0;
  const instruments = headers.map((h) => {
    let data: Float32Array = new Float32Array(0);
    if (h.length > 0 && body < sampleChunks.length) {
      const [at, end] = sampleChunks[body++]!;
      data = pcm8(bytes, at, Math.min(h.length, end - at), true);
    }
    const loopStart = Math.min(h.loopStart, data.length);
    const loopLength = Math.min(h.loopLength, data.length - loopStart);
    const looped = loopLength > 2;
    const sample: Sample = {
      name: h.name,
      data,
      loopStart: looped ? loopStart : 0,
      loopLength: looped ? loopLength : 0,
      loopType: looped ? LoopType.Forward : LoopType.None,
      volume: h.volume,
      panning: 128,
      // Oktalyzer plays C-3 at the Amiga PAL rate.
      ...tuningForRate(8287),
    };
    return sampleInstrument(h.name, sample);
  });
  for (const index of unloopedCopies) {
    const original = instruments[index]!.samples[0];
    if (!original) continue;
    while (instruments.length < index + 36) instruments.push(sampleInstrument('', null));
    instruments[index + 36] = sampleInstrument(original.name, { ...original, loopStart: 0, loopLength: 0, loopType: LoopType.None });
  }

  const orders = rawOrders.slice(0, songLength || rawOrders.length).filter((p) => p < patterns.length);
  if (orders.length === 0) orders.push(0);

  return {
    format: 'mod',
    formatName: 'Oktalyzer',
    title: '',
    channels,
    orders,
    restartPosition: 0,
    patterns,
    instruments,
    linearFrequency: false,
    initialSpeed: Math.min(31, speed),
    initialTempo: 125,
    channelPanning,
  };
}
