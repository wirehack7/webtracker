import { describe, expect, it } from 'vitest';
import { NOTE_KEY_OFF, type Cell, type Envelope } from './song.ts';
import { dcInstrument, probe, probeSong, type ProbeSong, type Tick } from './test-probe.ts';

/**
 * XM effects on the FastTracker 2 path, one by one, measured tick by tick.
 * The finer FT2 quirks have their own tests in the formats package (ft2.test.ts).
 */

const C4 = 49;
const BASE = 8363;
/** Frequency `delta` linear period units (1/768 octave) below C-4. */
const fx = (delta: number) => BASE * 2 ** (-delta / 768);

const play = (rows: ProbeSong['rows'], ticks: number, opts: Partial<ProbeSong> = {}) => probe(probeSong({ ...opts, rows }), ticks);
const note = (extra: Partial<Cell> = {}): Partial<Cell> => ({ note: C4, instrument: 1, ...extra });
const vol64 = (t: Tick) => Math.round(t.level * 64 * 1e4) / 1e4;
const pan = (t: Tick) => Math.round((255 * t.right ** 2) / (t.left ** 2 + t.right ** 2));

const env = (points: [number, number][], extra: Partial<Envelope> = {}): Envelope => ({
  enabled: true,
  points: points.map(([x, y]) => ({ x, y })),
  sustain: false,
  sustainPoint: 0,
  loop: false,
  loopStart: 0,
  loopEnd: 0,
  ...extra,
});

/** An instrument whose sample plays at volume 32. */
function half() {
  const ins = dcInstrument();
  ins.samples[0]!.volume = 32;
  return ins;
}

describe('FT2 path: pitch', () => {
  it('plays C-4 at 8363 Hz on both frequency tables', () => {
    expect(play([[note()]], 2).ticks[1]!.freq).toBeCloseTo(BASE, 3);
    expect(play([[note()]], 2, { linear: false }).ticks[1]!.freq).toBeCloseTo(BASE, 3);
  });

  it('slides with 1xx and 2xx, remembering the speed', () => {
    const up = play([[note({ effect: 0x01, param: 2 })], [{ effect: 0x01, param: 0 }]], 8).ticks;
    expect(up[5]!.freq).toBeCloseTo(fx(-40), 3);
    expect(up[7]!.freq).toBeCloseTo(fx(-48), 3);
    const down = play([[note({ effect: 0x02, param: 2 })], [{ effect: 0x02, param: 0 }]], 8).ticks;
    expect(down[7]!.freq).toBeCloseTo(fx(48), 3);
    const amiga = play([[note({ effect: 0x01, param: 4 })]], 2, { linear: false }).ticks;
    expect(amiga[1]!.freq).toBeCloseTo((BASE * 428) / 424, 3);
  });

  it('slides finely with E1x, E2x, X1y and X2y on the first tick, with memory', () => {
    const rows = (e: number, p: number) => [[note({ effect: e, param: p })], [{ effect: e, param: p & 0xf0 }]];
    expect(play(rows(0x0e, 0x13), 8).ticks[7]!.freq).toBeCloseTo(fx(-24), 3);
    expect(play(rows(0x0e, 0x23), 8).ticks[7]!.freq).toBeCloseTo(fx(24), 3);
    expect(play(rows(0x21, 0x13), 8).ticks[7]!.freq).toBeCloseTo(fx(-6), 3);
    expect(play(rows(0x21, 0x23), 8).ticks[7]!.freq).toBeCloseTo(fx(6), 3);
    expect(play(rows(0x21, 0x14), 8, { linear: false }).ticks[7]!.freq).toBeCloseTo((BASE * 428) / 426, 3);
    expect(play(rows(0x21, 0x24), 8, { linear: false }).ticks[7]!.freq).toBeCloseTo((BASE * 428) / 430, 3);
  });

  it('runs vibrato on FT2 half-sine table and puts the pitch back after it', () => {
    const { ticks } = play([[note({ effect: 0x04, param: 0x48 })]], 7);
    expect(ticks[1]!.freq).toBeCloseTo(BASE, 3);
    // Speed 4 steps 16 positions a tick: entries 4 and 8 of the table, times depth 8 / 32.
    expect(ticks[2]!.freq).toBeCloseTo(fx((97 * 8) >> 5), 3);
    expect(ticks[3]!.freq).toBeCloseTo(fx((180 * 8) >> 5), 3);
    expect(ticks[6]!.freq).toBeCloseTo(BASE, 3);
  });

  it('runs vibrato from the volume column', () => {
    const { ticks } = play([[note({ volume: 0xa4 })], [{ volume: 0xb8 }]], 9);
    expect(ticks[8]!.freq).toBeCloseTo(fx((97 * 8) >> 5), 3);
  });

  it('picks ramp and square vibrato with E4x', () => {
    const ramp = play([[note({ effect: 0x0e, param: 0x41 })], [{ effect: 0x04, param: 0x48 }]], 9).ticks;
    expect(ramp[8]!.freq).toBeCloseTo(fx((32 * 8) >> 5), 3);
    const square = play([[note({ effect: 0x0e, param: 0x42 })], [{ effect: 0x04, param: 0x48 }]], 8).ticks;
    expect(square[7]!.freq).toBeCloseTo(fx((255 * 8) >> 5), 3);
    // The ramp turns over at half way: position 128 is the top again, upwards.
    const late = play([[note({ effect: 0x0e, param: 0x41 })], [{ effect: 0x04, param: 0xf8 }]], 11).ticks;
    expect(late[10]!.freq).toBeCloseTo(fx(-(((~(13 << 3) & 0xff) * 8) >> 5)), 3);
  });

  it('slides to a note from the volume column', () => {
    // F2 is speed 32, four linear units each: 128 a tick, an octave in six ticks.
    const { ticks } = play([[note()], [{ note: C4 + 12, volume: 0xf2 }], [{ volume: 0xf0 }]], 14);
    expect(ticks[7]!.freq).toBeCloseTo(fx(-128), 3);
    expect(ticks[8]!.freq).toBeCloseTo(fx(-256), 3);
    expect(ticks[13]!.freq).toBeCloseTo(BASE * 2, 3);
  });

  it('sets the finetune with E5x', () => {
    const { ticks } = play([[note({ effect: 0x0e, param: 0x5f })]], 2);
    expect(ticks[1]!.freq).toBeCloseTo(fx(-56), 3);
  });

  it('runs the auto-vibrato waves', () => {
    const at = (type: number) => {
      const ins = dcInstrument({ vibratoType: type, vibratoDepth: 8, vibratoRate: 64 });
      return play([[note()]], 3, { instruments: [ins] }).ticks[2]!.freq;
    };
    expect(at(0)).toBeCloseTo(fx(8), 3);
    expect(at(1)).toBeCloseTo(fx(8), 3);
    expect(at(2)).toBeCloseTo(fx(-4), 3);
    expect(at(3)).toBeCloseTo(fx(4), 3);
    const amiga = play([[note()]], 3, { linear: false, instruments: [dcInstrument({ vibratoDepth: 8, vibratoRate: 64 })] });
    expect(amiga.ticks[2]!.freq).toBeCloseTo((BASE * 428) / 430, 3);
  });

  it('sweeps the auto-vibrato in, and uses the sweep step as depth after key off', () => {
    const ins = dcInstrument({ vibratoDepth: 8, vibratoRate: 64, vibratoSweep: 4 });
    const on = play([[note()]], 3, { instruments: [ins] }).ticks;
    expect(on[2]!.freq).toBeCloseTo(fx(6), 3);
    const off = play([[note({ effect: 0x14, param: 1 })]], 3, { instruments: [{ ...ins, volumeEnvelope: env([[0, 64]]) }] }).ticks;
    expect(off[2]!.freq).toBeCloseTo(fx(2), 3);
  });

  it('stops a note that would play above the table', () => {
    const ins = dcInstrument();
    ins.samples[0]!.relativeNote = 30;
    expect(play([[{ note: 95, instrument: 1 }]], 1, { instruments: [ins] }).ticks[0]!.level).toBe(0);
  });
});

describe('FT2 path: volume', () => {
  it('sets the volume from the volume column; 51 to 5F do nothing', () => {
    expect(vol64(play([[note({ volume: 0x30 })]], 1).ticks[0]!)).toBe(32);
    expect(vol64(play([[note({ volume: 0x50 })]], 1, { instruments: [half()] }).ticks[0]!)).toBe(64);
    expect(vol64(play([[note({ volume: 0x55 })]], 1, { instruments: [half()] }).ticks[0]!)).toBe(32);
  });

  it('slides with the volume column', () => {
    expect(vol64(play([[note({ volume: 0x63 })]], 6).ticks[5]!)).toBe(64 - 15);
    expect(vol64(play([[note({ volume: 0x73 })]], 6, { instruments: [half()] }).ticks[5]!)).toBe(47);
    expect(vol64(play([[note({ volume: 0x85 })]], 6).ticks[5]!)).toBe(59);
    expect(vol64(play([[note({ volume: 0x95 })]], 6, { instruments: [half()] }).ticks[5]!)).toBe(37);
  });

  it('sets the volume with Cxx and slides it with Axy, remembering it', () => {
    expect(vol64(play([[note({ effect: 0x0c, param: 0x80 })]], 1).ticks[0]!)).toBe(64);
    const { ticks } = play([[note({ effect: 0x0a, param: 0x04 })], [{ effect: 0x0a, param: 0 }], [{ effect: 0x0a, param: 0x30 }]], 18);
    expect(vol64(ticks[11]!)).toBe(24);
    expect(vol64(ticks[17]!)).toBe(39);
  });

  it('slides finely with EAx and EBx, remembering them', () => {
    const { ticks } = play(
      [[note({ effect: 0x0e, param: 0xa4 })], [{ effect: 0x0e, param: 0xa0 }], [{ effect: 0x0e, param: 0xb8 }], [{ effect: 0x0e, param: 0xb0 }]],
      24,
      { instruments: [half()] },
    );
    expect([5, 11, 17, 23].map((t) => vol64(ticks[t]!))).toEqual([36, 40, 32, 24]);
  });

  it('cuts with ECx on its tick, EC0 at once', () => {
    expect(play([[note({ effect: 0x0e, param: 0xc2 })]], 3).ticks.map(vol64)).toEqual([64, 64, 0]);
    expect(vol64(play([[note({ effect: 0x0e, param: 0xc0 })]], 1).ticks[0]!)).toBe(0);
  });

  it('runs tremolo on the FT2 table', () => {
    const { ticks } = play([[note({ effect: 0x07, param: 0x48 })]], 4, { instruments: [half()] });
    expect(ticks.slice(1).map(vol64)).toEqual([32, 32 + ((97 * 8) >> 6), 32 + ((180 * 8) >> 6)]);
    const square = play([[note({ effect: 0x0e, param: 0x72 })], [{ effect: 0x07, param: 0x48 }]], 8, { instruments: [half()] });
    expect(vol64(square.ticks[7]!)).toBe(32 + ((255 * 8) >> 6));
    // FT2 bug: the ramp tremolo turns with the vibrato position.
    const ramp = play([[note({ effect: 0x0e, param: 0x71 })], [{ effect: 0x07, param: 0x48 }]], 9, { instruments: [half()] });
    expect(vol64(ramp.ticks[8]!)).toBe(32 + ((32 * 8) >> 6));
    const rampDown = play([[note({ effect: 0x04, param: 0x80 })], [{ effect: 0x0e, param: 0x71 }], [{ effect: 0x07, param: 0x48 }]], 15, {
      instruments: [half()],
    });
    expect(vol64(rampDown.ticks[14]!)).toBe(32 + (((~32 & 0xff) * 8) >> 6));
  });

  it('turns the sound on and off with tremor, x+1 ticks on and y+1 off', () => {
    const { ticks } = play([[note({ effect: 0x1d, param: 0x21 })], [{ effect: 0x1d, param: 0 }]], 12);
    expect(ticks.slice(1, 6).map(vol64)).toEqual([64, 64, 64, 0, 0]);
    // The count runs on through the next row's first tick.
    expect(ticks.slice(7, 12).map(vol64)).toEqual([64, 64, 64, 0, 0]);
  });

  it('sets and slides the global volume, remembering the slide', () => {
    const { ticks } = play([[note({ effect: 0x10, param: 0x20 })], [{ effect: 0x11, param: 0x30 }], [{ effect: 0x11, param: 0 }], [{ effect: 0x11, param: 0x05 }]], 24);
    expect(vol64(ticks[0]!)).toBe(32);
    expect(vol64(ticks[11]!)).toBe(47);
    expect(vol64(ticks[17]!)).toBe(62);
    expect(vol64(ticks[23]!)).toBe(37);
  });

  it('sets and slides the channel volume (Mxx, Nxy)', () => {
    const { ticks } = play(
      [[note({ effect: 0x16, param: 0x20 })], [{ effect: 0x17, param: 0x20 }], [{ effect: 0x17, param: 0x03 }], [{ effect: 0x17, param: 0x4f }], [{ effect: 0x17, param: 0xf8 }]],
      30,
    );
    expect([0, 11, 17, 23, 29].map((t) => vol64(ticks[t]!))).toEqual([32, 42, 27, 31, 23]);
  });

  it('keys off with Kxx on its tick', () => {
    const { ticks } = play([[note({ effect: 0x14, param: 3 })]], 4);
    expect(ticks.map(vol64)).toEqual([64, 64, 64, 0]);
  });

  it('K00 or a key off with an instrument number keeps the sample volume', () => {
    expect(vol64(play([[note()], [{ effect: 0x14, param: 0, instrument: 1 }]], 7).ticks[6]!)).toBe(64);
    expect(vol64(play([[note()], [{ note: NOTE_KEY_OFF, instrument: 1 }]], 7).ticks[6]!)).toBe(64);
    expect(vol64(play([[note()], [{ note: NOTE_KEY_OFF }]], 7).ticks[6]!)).toBe(0);
  });

  it('resets the volume on an instrument number without a note, and keeps playing', () => {
    const p = play([[note({ volume: 0x10 })], [{ instrument: 1 }]], 7);
    expect(vol64(p.ticks[5]!)).toBe(0);
    expect(vol64(p.ticks[6]!)).toBe(64);
    expect(p.player.voices()[0]!.pos).toBeCloseTo((7 * BASE) / 50, 3);
  });

  it('stays silent for an empty sample', () => {
    const empty = dcInstrument({}, false, 0);
    expect(play([[note()]], 1, { instruments: [empty] }).ticks[0]!.level).toBe(0);
  });

  it('stops the note when the sample offset is past its end, looped or not', () => {
    const short = dcInstrument({}, true, 1000);
    expect(play([[note({ effect: 0x09, param: 0x10 })]], 1, { instruments: [short] }).ticks[0]!.level).toBe(0);
    const p = play([[note({ effect: 0x09, param: 2 })], [{ note: C4, effect: 0x09, param: 0 }]], 7);
    expect(p.player.voices()[0]!.pos).toBeCloseTo(512 + BASE / 50, 3);
  });
});

describe('FT2 path: multi retrigger', () => {
  const after: Record<number, number> = {
    0x1: 31, 0x2: 30, 0x3: 28, 0x4: 24, 0x5: 16, 0x6: 22, 0x7: 16, 0x8: 32,
    0x9: 33, 0xa: 34, 0xb: 36, 0xc: 40, 0xd: 48, 0xe: 48, 0xf: 64,
  };
  for (const [x, volume] of Object.entries(after)) {
    it(`changes the volume to ${volume} with R${Number(x).toString(16).toUpperCase()}3`, () => {
      const { ticks, player } = play([[note({ effect: 0x1b, param: (Number(x) << 4) | 3 })]], 3, { instruments: [half()] });
      // The note counts as the first tick, so the first retrigger comes a tick early.
      expect(vol64(ticks[1]!)).toBe(32);
      expect(vol64(ticks[2]!)).toBe(volume);
      expect(player.voices()[0]!.pos).toBeCloseTo(BASE / 50, 3);
    });
  }

  it('lets a volume column setting win and holds the counter on the first tick', () => {
    const { ticks, player } = play([[note({ volume: 0x20, effect: 0x1b, param: 0x72 })]], 3);
    expect(vol64(ticks[2]!)).toBe(16);
    expect(player.voices()[0]!.pos).toBeCloseTo(BASE / 50, 3);
  });

  it('pans with a volume column panning on each retrigger', () => {
    expect(pan(play([[note()], [{ volume: 0xc0, effect: 0x1b, param: 0x01 }]], 8).ticks[7]!)).toBe(0);
  });
});

describe('FT2 path: panning', () => {
  it('sets panning with 8xx, E8x and the volume column', () => {
    expect(pan(play([[note({ effect: 0x08, param: 0 })]], 1).ticks[0]!)).toBe(0);
    expect(pan(play([[note({ effect: 0x0e, param: 0x8f })]], 1).ticks[0]!)).toBe(255);
    expect(pan(play([[note({ volume: 0xc4 })]], 1).ticks[0]!)).toBe(64);
  });

  it('slides panning with Pxy (with memory) and the volume column', () => {
    expect(pan(play([[note({ effect: 0x19, param: 0x40 })], [{ effect: 0x19, param: 0 }]], 8).ticks[7]!)).toBe(128 + 6 * 4);
    expect(pan(play([[note({ effect: 0x19, param: 0x08 })]], 6).ticks[5]!)).toBe(128 - 40);
    expect(pan(play([[note({ volume: 0xd8 })]], 6).ticks[5]!)).toBe(128 - 40);
    expect(pan(play([[note({ volume: 0xe8 })]], 6).ticks[5]!)).toBe(128 + 40);
  });

  it('follows the panning envelope', () => {
    expect(pan(play([[note()]], 1, { instruments: [dcInstrument({ panningEnvelope: env([[0, 0]]) })] }).ticks[0]!)).toBe(0);
  });
});

describe('FT2 path: envelopes', () => {
  it('runs the volume envelope down its points', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 64], [4, 32]]) });
    expect(play([[note()]], 6, { instruments: [ins] }).ticks.map(vol64)).toEqual([64, 56, 48, 40, 32, 32]);
  });

  it('holds at the sustain point, then goes on and fades after key off', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 64], [4, 32]], { sustain: true }), fadeout: 4096 });
    const { ticks } = play([[note()], [{ note: NOTE_KEY_OFF }]], 9, { instruments: [ins] });
    expect(vol64(ticks[5]!)).toBe(64);
    expect(ticks.slice(6, 9).map(vol64)).toEqual([(64 * 7) / 8, (56 * 6) / 8, (48 * 5) / 8]);
  });

  it('loops the volume envelope', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 64], [2, 0]], { loop: true, loopStart: 0, loopEnd: 1 }) });
    expect(play([[note()]], 4, { instruments: [ins] }).ticks.map(vol64)).toEqual([64, 32, 64, 32]);
  });

  it('jumps in the envelopes with Lxx; the panning one only with volume sustain on', () => {
    const volumeEnvelope = env([[0, 64], [10, 0]], { sustain: true, sustainPoint: 1 });
    const panningEnvelope = env([[0, 32], [10, 0]]);
    const both = play([[note({ effect: 0x15, param: 5 })]], 1, { instruments: [dcInstrument({ volumeEnvelope, panningEnvelope })] });
    expect(both.ticks[0]!.level).toBeCloseTo(0.5, 2);
    expect(pan(both.ticks[0]!)).toBe(64);
    const volOnly = play([[note({ effect: 0x15, param: 5 })]], 1, {
      instruments: [dcInstrument({ volumeEnvelope: { ...volumeEnvelope, sustain: false }, panningEnvelope })],
    });
    expect(pan(volOnly.ticks[0]!)).toBe(128);
    // On a point exactly, and past the last point.
    const onPoint = play([[note({ effect: 0x15, param: 10 })]], 1, { instruments: [dcInstrument({ volumeEnvelope })] });
    expect(onPoint.ticks[0]!.level).toBe(0);
    const past = play([[note({ effect: 0x15, param: 40 })]], 1, { instruments: [dcInstrument({ volumeEnvelope })] });
    expect(past.ticks[0]!.level).toBe(0);
  });

  it('clamps envelope values above 64', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 0], [2, 128]]) });
    expect(play([[note()]], 3, { instruments: [ins] }).ticks.map(vol64)).toEqual([0, 64, 64]);
  });
});

describe('FT2 path: notes and sequencing', () => {
  const rowsOf = (p: ReturnType<typeof play>) => p.rows.map((r) => `${r.order}:${r.row}@${r.tick}`);

  it('delays a note with EDx and applies its volume column then', () => {
    const { ticks } = play([[note({ volume: 0x20, effect: 0x0e, param: 0xd2 })]], 3);
    expect(ticks.map(vol64)).toEqual([0, 0, 16]);
    const panned = play([[note({ volume: 0xc0, effect: 0x0e, param: 0xd1 })]], 2);
    expect(pan(panned.ticks[1]!)).toBe(0);
  });

  it('restarts the envelope on a delayed note without instrument', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 64], [6, 4]]) });
    const { ticks } = play([[note()], [{ note: C4, effect: 0x0e, param: 0xd1 }]], 8, { instruments: [ins] });
    expect(vol64(ticks[7]!)).toBe(64);
  });

  it('retriggers with E9x', () => {
    expect(play([[note({ effect: 0x0e, param: 0x92 })]], 5).player.voices()[0]!.pos).toBeCloseTo(BASE / 50, 3);
  });

  it('jumps with Bxx and breaks with Dxx', () => {
    const jump = play([[{ effect: 0x0b, param: 1 }]], 7, { patterns: 2, orders: [0, 1] });
    expect(rowsOf(jump)).toEqual(['0:0@0', '1:0@6']);
    const brk = play([[{ effect: 0x0d, param: 0x12 }]], 7, { patterns: 2, orders: [0, 1] });
    expect(rowsOf(brk)).toEqual(['0:0@0', '1:12@6']);
    const far = play([[{ effect: 0x0d, param: 0x70 }]], 7, { patterns: 2, orders: [0, 1] });
    expect(rowsOf(far)).toEqual(['0:0@0', '1:0@6']);
    const back = play([[{ effect: 0x0b, param: 0 }]], 7);
    expect(back.player.loops).toBe(1);
  });

  it('wraps past the last order to the restart position, or the start when that is invalid', () => {
    const song = probeSong({ rows: [[{ effect: 0x0d, param: 0 }]], orders: [0, 0, 0] });
    song.restartPosition = 1;
    expect(probe(song, 19).rows.map((r) => r.order)).toEqual([0, 1, 2, 1]);
    song.restartPosition = 9;
    expect(probe(song, 19).rows.map((r) => r.order)).toEqual([0, 1, 2, 0]);
  });

  it('repeats rows with E6x', () => {
    const p = play([[], [{ effect: 0x0e, param: 0x60 }], [{ effect: 0x0e, param: 0x62 }]], 6 * 8);
    expect(p.rows.map((r) => r.row)).toEqual([0, 1, 2, 1, 2, 1, 2, 3]);
  });

  it('delays the pattern with EEx and keeps running effects on the repeats', () => {
    const p = play([[note({ effect: 0x0e, param: 0xe1 })], [], [note({ effect: 0x0a, param: 0x01 })], [{ effect: 0x0e, param: 0xe1 }]], 31);
    expect(rowsOf(p).slice(0, 2)).toEqual(['0:0@0', '0:1@12']);
  });

  it('sets the speed and tempo with Fxx; F00 does nothing', () => {
    expect(rowsOf(play([[{ effect: 0x0f, param: 2 }]], 3))).toEqual(['0:0@0', '0:1@2']);
    expect(play([[{ effect: 0x0f, param: 0x80 }]], 1).player.tempo).toBe(128);
    expect(play([[{ effect: 0x0f, param: 0 }]], 1).player.speed).toBe(6);
  });

  it('plays the same pattern again when told to loop it', () => {
    const p = probe(probeSong({ rows: [[{ effect: 0x0b, param: 1 }]], patterns: 2, orders: [0, 1] }), 13, (pl) => (pl.loopPattern = true));
    expect(p.rows.map((r) => r.order)).toEqual([0, 0, 0]);
  });
});
