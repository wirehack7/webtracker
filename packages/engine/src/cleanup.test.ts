import { describe, expect, it } from 'vitest';
import { cleanupPreview, cleanupSong, type CleanupOptions } from './cleanup.ts';
import { createSong, writeCell } from './edit.ts';
import { emptyInstrument } from './sample-edit.ts';
import { LoopType, emptyPattern, readCell, type Sample, type Song } from './song.ts';

const none: CleanupOptions = { unusedPatterns: false, duplicatePatterns: false, unusedInstruments: false, compactInstruments: false, unusedSamples: false, sampleTails: false };

const sample = (length: number, loop?: [number, number]): Sample => ({
  name: '',
  data: new Float32Array(length).fill(0.5),
  loopStart: loop?.[0] ?? 0,
  loopLength: loop?.[1] ?? 0,
  loopType: loop ? LoopType.Forward : LoopType.None,
  volume: 64,
  finetune: 0,
  panning: 128,
  relativeNote: 0,
});

/** Patterns 0..3; orders play 2, 0, 2, 3, and pattern 3 copies pattern 0. */
function song(): Song {
  const s = createSong(2);
  s.patterns = [0, 1, 2, 3].map(() => emptyPattern(16, 2));
  s.instruments = [1, 2, 3, 4].map((n) => ({ ...emptyInstrument(`ins ${n}`), samples: [sample(100)] }));
  writeCell(s, s.patterns[0]!, 0, 0, { note: 49, instrument: 2 });
  writeCell(s, s.patterns[1]!, 0, 0, { note: 49, instrument: 1 });
  writeCell(s, s.patterns[2]!, 0, 1, { note: 49, instrument: 4 });
  writeCell(s, s.patterns[3]!, 0, 0, { note: 49, instrument: 2 });
  s.orders = [2, 0, 2, 3];
  return s;
}

describe('cleanupSong', () => {
  it('drops unused patterns and keeps the order positions', () => {
    const s = song();
    expect(cleanupSong(s, { ...none, unusedPatterns: true }).patterns).toBe(1);
    expect(s.patterns).toHaveLength(3);
    expect(s.orders).toEqual([1, 0, 1, 2]);
    expect(readCell(s, s.patterns[1]!, 0, 1).instrument).toBe(4);
  });

  it('merges duplicate patterns', () => {
    const s = song();
    expect(cleanupSong(s, { ...none, unusedPatterns: true, duplicatePatterns: true }).patterns).toBe(2);
    expect(s.orders).toEqual([1, 0, 1, 0]);
    const t = song();
    expect(cleanupSong(t, { ...none, duplicatePatterns: true }).patterns).toBe(1);
    // Pattern 1 is unused but stays, since only copies were asked for.
    expect(t.orders).toEqual([2, 0, 2, 0]);
  });

  it('clears and renumbers instruments', () => {
    const s = song();
    const result = cleanupSong(s, { ...none, unusedPatterns: true, unusedInstruments: true, compactInstruments: true });
    // Instrument 1 was only in the dropped pattern, 3 never played.
    expect(result.instruments).toBe(2);
    expect(s.instruments.map((i) => i.name)).toEqual(['ins 2', 'ins 4']);
    expect(readCell(s, s.patterns[0]!, 0, 0).instrument).toBe(1);
    expect(readCell(s, s.patterns[1]!, 0, 1).instrument).toBe(2);
  });

  it('keeps instruments of unused patterns unless those go too', () => {
    const s = song();
    cleanupSong(s, { ...none, unusedInstruments: true });
    expect(s.instruments.map((i) => i.samples.length)).toEqual([1, 1, 0, 1]);
  });

  it('drops samples no note reaches and cuts loop tails', () => {
    const s = song();
    const ins = s.instruments[1]!;
    ins.samples = [sample(100, [10, 20]), sample(50), sample(70)];
    ins.keymap.fill(1);
    ins.keymap.fill(2, 60);
    // C-4 plays sample 1; a note without instrument on the same channel follows instrument 2 and reaches sample 2.
    writeCell(s, s.patterns[0]!, 4, 0, { note: 70 });
    const result = cleanupSong(s, { ...none, unusedSamples: true, sampleTails: true });
    expect(result.samples).toBe(1);
    expect(ins.samples.map((x) => x.data.length)).toEqual([50, 70]);
    expect(ins.keymap[48]).toBe(0);
    expect(ins.keymap[69]).toBe(1);
    s.instruments[0]!.samples = [sample(100, [10, 20])];
    expect(cleanupSong(s, { ...none, sampleTails: true }).frames).toBe(70);
    expect(s.instruments[0]!.samples[0]!.data.length).toBe(30);
  });

  it('previews without changing the song', () => {
    const s = song();
    const result = cleanupPreview(s, { ...none, unusedPatterns: true, unusedInstruments: true });
    expect(result).toMatchObject({ patterns: 1, instruments: 2 });
    expect(s.patterns).toHaveLength(4);
  });
});
