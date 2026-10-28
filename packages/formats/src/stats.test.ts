import { describe, expect, it } from 'vitest';
import { createSong, emptyPattern, LoopType, writeCell } from '@webtracker/engine';
import { songStats } from './stats.ts';
import { saveXm, xmLayout } from './xm-write.ts';

function song() {
  const s = createSong(4);
  s.patterns.push(emptyPattern(32, 4));
  writeCell(s, s.patterns[0]!, 0, 0, { note: 49, instrument: 1 });
  const smooth = s.instruments[1]!.samples[0]!;
  smooth.data = new Float32Array(300).map((_, i) => Math.sin(i / 7) * 0.3);
  smooth.loopType = LoopType.Forward;
  smooth.loopStart = 0;
  smooth.loopLength = 200;
  return s;
}

describe('xmLayout', () => {
  it('adds up to the saved file', () => {
    const s = song();
    const layout = xmLayout(s);
    expect(layout.total).toBe(saveXm(s).length);
    const parts = layout.header + layout.patterns.reduce((a, b) => a + b, 0) + layout.instruments.reduce((a, i) => a + i.header + i.samples.reduce((b, x) => b + x.bytes, 0), 0);
    expect(parts).toBe(layout.total);
  });
});

describe('songStats', () => {
  it('sizes every part and marks what the song never plays', () => {
    const s = song();
    const stats = songStats(s);
    expect(stats.header + stats.patternBytes + stats.instrumentBytes + stats.sampleBytes).toBe(stats.xm);
    expect(stats.patterns.map((p) => [p.rows, p.positions])).toEqual([[64, 1], [32, 0]]);
    // An empty pattern is stored without data.
    expect(stats.patterns[1]!.bytes).toBe(9);
    const [first, second] = stats.instruments;
    expect(first).toMatchObject({ number: 1, used: true });
    expect(first!.samples[0]).toMatchObject({ used: true, bits: 8 });
    expect(second).toMatchObject({ number: 2, used: false });
    expect(second!.samples[0]).toMatchObject({ frames: 300, bits: 16, bytes: 600, used: false, tail: 100 });
    expect(stats.mod.bytes).toBeGreaterThan(1084);
  });
});
