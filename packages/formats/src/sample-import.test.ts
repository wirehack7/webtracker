import { describe, expect, it } from 'vitest';
import { chipInstruments, LoopType } from '@webtracker/engine';
import { importSample } from './sample-import.ts';
import { saveXi } from './xm-write.ts';

class Bytes {
  private out: number[] = [];
  str(s: string) {
    for (const c of s) this.out.push(c.charCodeAt(0));
    return this;
  }
  u8(v: number) {
    this.out.push(v & 0xff);
    return this;
  }
  u16(v: number, le = true) {
    return le ? this.u8(v).u8(v >> 8) : this.u8(v >> 8).u8(v);
  }
  u32(v: number, le = true) {
    return le ? this.u16(v & 0xffff).u16(v >>> 16) : this.u16(v >>> 16, false).u16(v & 0xffff, false);
  }
  bytes(b: number[]) {
    this.out.push(...b);
    return this;
  }
  get length() {
    return this.out.length;
  }
  buffer() {
    return Uint8Array.from(this.out).buffer;
  }
}

function wav16Stereo(frames: [number, number][], rate: number, loop?: [number, number]) {
  const data = new Bytes();
  for (const [l, r] of frames) data.u16(l & 0xffff).u16(r & 0xffff);
  const smpl = loop ? new Bytes().u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u32(1).u32(0).u32(0).u32(0).u32(loop[0]).u32(loop[1]).u32(0).u32(0) : null;
  const fmt = new Bytes().u16(1).u16(2).u32(rate).u32(rate * 4).u16(4).u16(16);
  const chunks = new Bytes().str('WAVE').str('fmt ').u32(fmt.length).bytes([...new Uint8Array(fmt.buffer())]);
  chunks.str('data').u32(data.length).bytes([...new Uint8Array(data.buffer())]);
  if (smpl) chunks.str('smpl').u32(smpl.length).bytes([...new Uint8Array(smpl.buffer())]);
  return new Bytes().str('RIFF').u32(chunks.length).bytes([...new Uint8Array(chunks.buffer())]).buffer();
}

describe('importSample', () => {
  it('reads a 16-bit stereo WAV, mixes it to mono, tunes it and reads the smpl loop', () => {
    const result = importSample(wav16Stereo([[16384, 0], [0, -16384], [8192, 8192], [0, 0]], 16726, [1, 2]), 'kick.wav');
    expect(result?.kind).toBe('sample');
    if (result?.kind !== 'sample') return;
    const s = result.sample;
    expect(s.name).toBe('kick');
    expect(Array.from(s.data)).toEqual([0.25, -0.25, 0.25, 0]);
    expect([s.relativeNote, s.finetune]).toEqual([12, 0]);
    expect([s.loopType, s.loopStart, s.loopLength]).toEqual([LoopType.Forward, 1, 2]);
  });

  it('reads 8-bit unsigned WAV', () => {
    const fmt = new Bytes().u16(1).u16(1).u32(8363).u32(8363).u16(1).u16(8);
    const body = new Bytes().str('WAVE').str('fmt ').u32(16).bytes([...new Uint8Array(fmt.buffer())]).str('data').u32(3).bytes([128, 192, 64]).u8(0);
    const result = importSample(new Bytes().str('RIFF').u32(body.length).bytes([...new Uint8Array(body.buffer())]).buffer());
    expect(result?.kind === 'sample' && Array.from(result.sample.data)).toEqual([0, 0.5, -0.5]);
  });

  it('reads a 16-bit AIFF with its 80-bit sample rate', () => {
    // 44100 Hz as 80-bit extended: exponent 0x400E, mantissa 0xAC44 << 48.
    const comm = new Bytes().u16(1, false).u32(2, false).u16(16, false).bytes([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
    const ssnd = new Bytes().u32(0, false).u32(0, false).u16(0x4000, false).u16(0xc000, false);
    const form = new Bytes().str('AIFF').str('COMM').u32(comm.length, false).bytes([...new Uint8Array(comm.buffer())]).str('SSND').u32(ssnd.length, false).bytes([...new Uint8Array(ssnd.buffer())]);
    const result = importSample(new Bytes().str('FORM').u32(form.length, false).bytes([...new Uint8Array(form.buffer())]).buffer());
    expect(result?.kind).toBe('sample');
    if (result?.kind !== 'sample') return;
    expect(result.rate).toBe(44100);
    expect(Array.from(result.sample.data)).toEqual([0.5, -0.5]);
  });

  it('reads an 8SVX sample with its loop', () => {
    const vhdr = new Bytes().u32(2, false).u32(2, false).u32(0, false).u16(8363, false).u8(1).u8(0).u32(0x10000, false);
    const body = [64, 0xc0, 0, 32];
    const form = new Bytes().str('8SVX').str('VHDR').u32(vhdr.length, false).bytes([...new Uint8Array(vhdr.buffer())]).str('BODY').u32(4, false).bytes(body);
    const result = importSample(new Bytes().str('FORM').u32(form.length, false).bytes([...new Uint8Array(form.buffer())]).buffer(), 'snare.8svx');
    expect(result?.kind).toBe('sample');
    if (result?.kind !== 'sample') return;
    expect(Array.from(result.sample.data)).toEqual([0.5, -0.5, 0, 0.25]);
    expect([result.sample.loopStart, result.sample.loopLength]).toEqual([2, 2]);
  });

  it('round-trips an instrument through XI', () => {
    const ins = chipInstruments()[1]!;
    ins.volumeEnvelope = { enabled: true, points: [{ x: 0, y: 64 }, { x: 8, y: 20 }], sustain: true, sustainPoint: 1, loop: false, loopStart: 0, loopEnd: 0 };
    ins.fadeout = 300;
    ins.vibratoDepth = 4;
    const result = importSample(saveXi(ins).slice().buffer);
    expect(result?.kind).toBe('instrument');
    if (result?.kind !== 'instrument') return;
    const back = result.instrument;
    expect(back.name).toBe(ins.name);
    expect(back.volumeEnvelope).toEqual(ins.volumeEnvelope);
    expect(back.fadeout).toBe(300);
    expect(back.vibratoDepth).toBe(4);
    expect(Array.from(back.samples[0]!.data)).toEqual(Array.from(ins.samples[0]!.data));
  });

  it('returns null for formats it leaves to the browser', () => {
    expect(importSample(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]).buffer)).toBeNull();
  });
});
