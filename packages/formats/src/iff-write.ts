import { LoopType, type Sample } from '@webtracker/engine';

/**
 * Writes a sample as an IFF 8SVX file, the Amiga's own sample format. 8SVX
 * holds 8-bit mono data and one forward loop, so frames after the loop end
 * are dropped and a ping-pong loop is saved as a forward one.
 */
export function save8svx(sample: Sample, rate: number): Uint8Array {
  const looped = sample.loopType !== LoopType.None && sample.loopLength > 0;
  const frames = looped ? Math.min(sample.data.length, sample.loopStart + sample.loopLength) : sample.data.length;
  const oneShot = looped ? sample.loopStart : frames;
  const name = [...sample.name].map((c) => (c.charCodeAt(0) < 128 ? c : '?')).join('');
  const chunks: [string, Uint8Array][] = [];

  const vhdr = new Uint8Array(20);
  const v = new DataView(vhdr.buffer);
  v.setUint32(0, oneShot);
  v.setUint32(4, frames - oneShot);
  v.setUint32(8, 0);
  v.setUint16(12, Math.max(1, Math.min(65535, Math.round(rate))));
  vhdr[14] = 1; // one octave
  vhdr[15] = 0; // no compression
  v.setUint32(16, Math.round((Math.min(64, sample.volume) / 64) * 0x10000));
  chunks.push(['VHDR', vhdr]);
  if (name) chunks.push(['NAME', Uint8Array.from(name, (c) => c.charCodeAt(0))]);
  const body = new Uint8Array(frames);
  for (let i = 0; i < frames; i++) body[i] = Math.max(-128, Math.min(127, Math.round(sample.data[i]! * 128))) & 0xff;
  chunks.push(['BODY', body]);

  const size = 4 + chunks.reduce((n, [, d]) => n + 8 + d.length + (d.length & 1), 0);
  const out = new Uint8Array(8 + size);
  const o = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'FORM');
  o.setUint32(4, size);
  ascii(8, '8SVX');
  let at = 12;
  for (const [id, data] of chunks) {
    ascii(at, id);
    o.setUint32(at + 4, data.length);
    out.set(data, at + 8);
    at += 8 + data.length + (data.length & 1);
  }
  return out;
}
