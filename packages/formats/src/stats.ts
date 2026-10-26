/**
 * Song statistics for making modules small, as demos and intros need them:
 * what each part takes in the saved file and what the song never plays.
 */
import { LoopType, songUsage, type Song } from '@webtracker/engine';
import { saveMod } from './mod-write.ts';
import { xmLayout } from './xm-write.ts';

export interface SampleStats {
  /** Index within its instrument, from 0. */
  index: number;
  name: string;
  frames: number;
  bits: 8 | 16;
  /** Sample data in the XM file. */
  bytes: number;
  /** A played note reaches it. */
  used: boolean;
  /** Frames after the loop end, which are never heard. */
  tail: number;
}

export interface InstrumentStats {
  /** Instrument number, from 1. */
  number: number;
  name: string;
  /** Header, sample headers and sample data in the XM file. */
  bytes: number;
  /** A played pattern names it. */
  used: boolean;
  samples: SampleStats[];
}

export interface PatternStats {
  index: number;
  rows: number;
  /** Packed pattern in the XM file. */
  bytes: number;
  /** How often the order list plays it; 0 when never. */
  positions: number;
}

export interface SongStats {
  /** The whole song saved as XM. */
  xm: number;
  /** XM header and order list. */
  header: number;
  patternBytes: number;
  /** Instrument and sample headers. */
  instrumentBytes: number;
  sampleBytes: number;
  /** The song saved as MOD, and whether MOD had to leave something out. */
  mod: { bytes: number; lossy: boolean };
  patterns: PatternStats[];
  /** Instruments that hold something: samples or a name. */
  instruments: InstrumentStats[];
}

export function songStats(song: Song): SongStats {
  const layout = xmLayout(song);
  const usage = songUsage(song);
  const positions = new Map<number, number>();
  for (const p of song.orders) positions.set(p, (positions.get(p) ?? 0) + 1);

  const patterns = layout.patterns.map((bytes, index) => ({ index, rows: song.patterns[index]!.rows, bytes, positions: positions.get(index) ?? 0 }));
  const instruments: InstrumentStats[] = [];
  let instrumentBytes = 0;
  let sampleBytes = 0;
  layout.instruments.forEach((written, i) => {
    const ins = song.instruments[i]!;
    const data = written.samples.reduce((sum, s) => sum + s.bytes, 0);
    instrumentBytes += written.header;
    sampleBytes += data;
    if (!ins.name && ins.samples.every((s) => s.data.length === 0)) return;
    const reached = usage.samples.get(i + 1);
    instruments.push({
      number: i + 1,
      name: ins.name,
      bytes: written.header + data,
      used: usage.instruments.has(i + 1),
      samples: written.samples.map((w, index) => {
        const s = ins.samples[index]!;
        const looped = s.loopType !== LoopType.None && s.loopLength > 0;
        return {
          index,
          name: s.name,
          frames: s.data.length,
          bits: w.is16 ? 16 : 8,
          bytes: w.bytes,
          used: reached?.has(index) ?? false,
          tail: looped ? Math.max(0, s.data.length - s.loopStart - s.loopLength) : 0,
        };
      }),
    });
  });

  const mod = saveMod(song);
  return {
    xm: layout.total,
    header: layout.header,
    patternBytes: layout.patterns.reduce((a, b) => a + b, 0),
    instrumentBytes,
    sampleBytes,
    mod: { bytes: mod.bytes.length, lossy: mod.warnings.length > 0 },
    patterns,
    instruments,
  };
}
