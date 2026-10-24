import { describe, expect, it } from 'vitest';
import { createSong, LoopType, NOTE_KEY_OFF, readCell, resizePattern, writeCell } from '@webtracker/engine';
import { loadMod } from './mod.ts';
import { saveMod } from './mod-write.ts';
import { encodeWav } from './wav-write.ts';
import { loadWav } from './sample-import.ts';
import { createZip, crc32 } from './zip.ts';

describe('saveMod', () => {
  it('round-trips notes, effects, samples and loops', () => {
    const song = createSong(4);
    song.title = 'mod test';
    const p = song.patterns[0]!;
    writeCell(song, p, 0, 0, { note: 49, instrument: 1, effect: 0x0f, param: 0x05 });
    writeCell(song, p, 1, 1, { note: 37, instrument: 3, volume: 0x10 + 32 });
    writeCell(song, p, 2, 2, { note: NOTE_KEY_OFF });
    writeCell(song, p, 3, 3, { effect: 0x10, param: 0x40 });
    const { bytes, warnings } = saveMod(song);
    const back = loadMod(bytes.slice().buffer);

    expect(back.title).toBe('mod test');
    expect(back.channels).toBe(4);
    expect(back.formatName).toContain('M.K.');
    const at = (row: number, ch: number) => readCell(back, back.patterns[0]!, row, ch);
    expect(at(0, 0)).toMatchObject({ note: 49, instrument: 1, effect: 0x0f, param: 0x05 });
    // The volume column moved into Cxx.
    expect(at(1, 1)).toMatchObject({ note: 37, instrument: 3, effect: 0x0c, param: 32 });
    expect(at(2, 2)).toMatchObject({ note: 0, effect: 0x0c, param: 0 });
    expect(at(3, 3)).toMatchObject({ effect: 0, param: 0 });
    expect(warnings.some((w) => w.includes('XM-only effects'))).toBe(true);

    const s = back.instruments[0]!.samples[0]!;
    const orig = song.instruments[0]!.samples[0]!;
    expect(Array.from(s.data)).toEqual(Array.from(orig.data));
    expect(s.loopType).toBe(LoopType.Forward);
    expect(s.loopLength).toBe(orig.loopLength);
  });

  it('ends short patterns with a pattern break and names the tag by channel count', () => {
    const song = createSong(6);
    song.patterns[0] = resizePattern(song, song.patterns[0]!, 32);
    const back = loadMod(saveMod(song).bytes.slice().buffer);
    expect(back.channels).toBe(6);
    expect(readCell(back, back.patterns[0]!, 31, 0)).toMatchObject({ effect: 0x0d, param: 0 });
  });

  it('writes the ProTracker conventions for empty slots and restart', () => {
    const { bytes } = saveMod(createSong(4));
    // Slot 31 is empty: repeat length one word, like ProTracker writes it.
    expect((bytes[20 + 30 * 30 + 28]! << 8) | bytes[20 + 30 * 30 + 29]!).toBe(1);
    expect(bytes[951]).toBe(127);
    expect(loadMod(bytes.slice().buffer).restartPosition).toBe(0);
  });

  it('shifts notes by the relative note so the pitch stays', () => {
    const song = createSong(4);
    song.instruments[0]!.samples[0]!.relativeNote = 12;
    writeCell(song, song.patterns[0]!, 0, 0, { note: 49, instrument: 1 });
    const back = loadMod(saveMod(song).bytes.slice().buffer);
    expect(readCell(back, back.patterns[0]!, 0, 0).note).toBe(61);
  });
});

describe('encodeWav', () => {
  it('writes 16-bit, 24-bit and float files that read back', () => {
    const left = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5);
    const right = left.map((v) => -v);
    for (const format of ['pcm16', 'pcm24', 'float32'] as const) {
      const wav = encodeWav([left, right], 44100, format);
      const back = loadWav(wav.slice().buffer, 'x.wav');
      if (back.kind !== 'sample') throw new Error('expected a sample');
      expect(back.rate).toBe(44100);
      expect(back.sample.data.length).toBe(100);
      // Left and right cancel in the mono mixdown.
      expect(Math.max(...back.sample.data.map(Math.abs))).toBeLessThan(1e-4);
    }
    const mono = encodeWav([left], 22050, 'pcm24');
    const back = loadWav(mono.slice().buffer);
    if (back.kind !== 'sample') throw new Error('expected a sample');
    expect(back.sample.data[10]).toBeCloseTo(left[10]!, 5);
  });
});

describe('createZip', () => {
  it('stores files with their CRC', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const zip = createZip([
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'b.txt', data: new Uint8Array(0) },
    ]);
    const v = new DataView(zip.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    expect(new TextDecoder().decode(zip.subarray(35, 40))).toBe('hello');
  });
});
