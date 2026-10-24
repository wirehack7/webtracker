import { CELL_SIZE, LoopType, type Envelope, type Instrument, type Sample, type Song } from '@webtracker/engine';

const TRACKER_NAME = 'webtracker';
const HEADER_SIZE = 276;
const INSTRUMENT_HEADER_SIZE = 263;
const SAMPLE_HEADER_SIZE = 40;

class Writer {
  private bytes = new Uint8Array(1 << 16);
  private view = new DataView(this.bytes.buffer);
  length = 0;

  private reserve(n: number): number {
    const at = this.length;
    if (at + n > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.bytes.length * 2, at + n));
      grown.set(this.bytes);
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length += n;
    return at;
  }

  u8(v: number) {
    this.bytes[this.reserve(1)] = v & 0xff;
  }
  u16(v: number) {
    this.view.setUint16(this.reserve(2), v, true);
  }
  u32(v: number) {
    this.view.setUint32(this.reserve(4), v, true);
  }
  /** Fixed-length ASCII, NUL padded; anything outside printable ASCII becomes a space. */
  text(s: string, length: number) {
    const at = this.reserve(length);
    for (let i = 0; i < length; i++) {
      const c = s.charCodeAt(i);
      this.bytes[at + i] = i >= s.length ? 0 : c >= 32 && c < 127 ? c : 32;
    }
  }
  raw(data: Uint8Array) {
    this.bytes.set(data, this.reserve(data.length));
  }
  zeros(n: number) {
    this.reserve(n);
  }
  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/** XM packs each cell: a mask byte (0x80 | fields present), then only the non-zero fields. */
function packPattern(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let o = 0; o < data.length; o += CELL_SIZE) {
    const cell = data.subarray(o, o + CELL_SIZE);
    let mask = 0;
    for (let k = 0; k < CELL_SIZE; k++) if (cell[k]) mask |= 1 << k;
    if (mask === 0x1f) {
      out.push(...cell);
      continue;
    }
    out.push(0x80 | mask);
    for (let k = 0; k < CELL_SIZE; k++) if (cell[k]) out.push(cell[k]!);
  }
  // A pattern of nothing but empty cells is stored without data, as FT2 does.
  return out.every((b) => b === 0x80) ? new Uint8Array(0) : Uint8Array.from(out);
}

/** True when every frame is an exact 8-bit value, so 8 bits lose nothing. */
function fitsIn8Bit(data: Float32Array): boolean {
  for (const v of data) {
    const s = v * 128;
    if (s !== Math.round(s) || s < -128 || s > 127) return false;
  }
  return true;
}

function encodeSample(sample: Sample): { bytes: Uint8Array; is16: boolean } {
  const is16 = !fitsIn8Bit(sample.data);
  if (!is16) {
    const bytes = new Uint8Array(sample.data.length);
    let prev = 0;
    sample.data.forEach((v, i) => {
      const s = Math.round(v * 128);
      bytes[i] = (s - prev) & 0xff;
      prev = s;
    });
    return { bytes, is16 };
  }
  const bytes = new Uint8Array(sample.data.length * 2);
  const view = new DataView(bytes.buffer);
  let prev = 0;
  sample.data.forEach((v, i) => {
    const s = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
    view.setUint16(i * 2, (s - prev) & 0xffff, true);
    prev = s;
  });
  return { bytes, is16 };
}

function envelopeType(env: Envelope): number {
  return (env.enabled ? 1 : 0) | (env.sustain ? 2 : 0) | (env.loop ? 4 : 0);
}

function writeEnvelopePoints(w: Writer, env: Envelope) {
  for (let i = 0; i < 12; i++) {
    const p = env.points[i];
    w.u16(p?.x ?? 0);
    w.u16(p?.y ?? 0);
  }
}

function writeInstrument(w: Writer, ins: Instrument) {
  const samples = ins.samples.slice(0, 16);
  const encoded = samples.map(encodeSample);

  w.u32(INSTRUMENT_HEADER_SIZE);
  w.text(ins.name, 22);
  w.u8(0);
  w.u16(samples.length);
  w.u32(SAMPLE_HEADER_SIZE);
  for (let k = 0; k < 96; k++) w.u8(ins.keymap[k] ?? 0);
  writeEnvelopePoints(w, ins.volumeEnvelope);
  writeEnvelopePoints(w, ins.panningEnvelope);
  const vol = ins.volumeEnvelope;
  const pan = ins.panningEnvelope;
  w.u8(Math.min(12, vol.points.length));
  w.u8(Math.min(12, pan.points.length));
  w.u8(vol.sustainPoint);
  w.u8(vol.loopStart);
  w.u8(vol.loopEnd);
  w.u8(pan.sustainPoint);
  w.u8(pan.loopStart);
  w.u8(pan.loopEnd);
  w.u8(envelopeType(vol));
  w.u8(envelopeType(pan));
  w.u8(ins.vibratoType);
  w.u8(ins.vibratoSweep);
  w.u8(ins.vibratoDepth);
  w.u8(ins.vibratoRate);
  w.u16(ins.fadeout);
  w.zeros(22);

  samples.forEach((s, i) => {
    const { bytes, is16 } = encoded[i]!;
    const scale = is16 ? 2 : 1;
    const looped = s.loopType !== LoopType.None && s.loopLength > 0;
    w.u32(bytes.length);
    w.u32(looped ? s.loopStart * scale : 0);
    w.u32(looped ? s.loopLength * scale : 0);
    w.u8(s.volume);
    w.u8(s.finetune);
    w.u8((looped ? (s.loopType === LoopType.PingPong ? 2 : 1) : 0) | (is16 ? 0x10 : 0));
    w.u8(s.panning);
    w.u8(s.relativeNote);
    w.u8(0);
    w.text(s.name, 22);
  });
  for (const { bytes } of encoded) w.raw(bytes);
}

/** Writes the song as an FT2-compatible XM 1.04 file. */
export function saveXm(song: Song): Uint8Array {
  const w = new Writer();
  const orders = song.orders.slice(0, 256);
  const patterns = song.patterns.slice(0, 256);
  const instruments = song.instruments.slice(0, 128);

  w.text('Extended Module: ', 17);
  w.text(song.title, 20);
  w.u8(0x1a);
  w.text(TRACKER_NAME, 20);
  w.u16(0x0104);
  w.u32(HEADER_SIZE);
  w.u16(orders.length);
  w.u16(song.restartPosition);
  w.u16(song.channels);
  w.u16(patterns.length);
  w.u16(instruments.length);
  w.u16(song.linearFrequency ? 1 : 0);
  w.u16(song.initialSpeed);
  w.u16(song.initialTempo);
  for (let i = 0; i < 256; i++) w.u8(orders[i] ?? 0);

  for (const pattern of patterns) {
    const packed = packPattern(pattern.data);
    w.u32(9);
    w.u8(0);
    w.u16(pattern.rows);
    w.u16(packed.length);
    w.raw(packed);
  }

  for (const ins of instruments) writeInstrument(w, ins);
  return w.result();
}
