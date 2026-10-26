import { describe, expect, it } from 'vitest';
import { NOTE_KEY_OFF, type Cell, type Envelope } from './song.ts';
import { dcInstrument, probe, probeSong, type ProbeSong } from './test-probe.ts';

/**
 * The shared playback path for songs imported from S3M and IT (`song.compat`),
 * which runs effects without FastTracker 2's or ProTracker's quirks. Every
 * effect is checked by what it does to pitch, level or panning, tick by tick.
 */

const C4 = 49;
/** C-4 on the Amiga table is period 428, which plays the sample at 8363 Hz. */
const BASE = 8363;
const freqOf = (period: number) => (BASE * 428) / period;
const semitones = (hz: number) => 12 * Math.log2(hz / BASE);

const play = (rows: ProbeSong['rows'], ticks: number, opts: Partial<ProbeSong> = {}) =>
  probe(probeSong({ compat: 's3m', ...opts, rows }), ticks);
/** A note on C-4 with instrument 1 plus `extra`. */
const note = (extra: Partial<Cell> = {}): Partial<Cell> => ({ note: C4, instrument: 1, ...extra });

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

describe('compat playback: pitch', () => {
  it('plays C-4 at the sample rate of the Amiga table', () => {
    const { ticks } = play([[note()]], 3);
    expect(ticks[1]!.freq).toBeCloseTo(BASE, 3);
    expect(ticks[1]!.level).toBeCloseTo(1, 6);
  });

  it('slides up with 1xx on every tick but the first, and remembers the speed', () => {
    const { ticks } = play([[note({ effect: 0x01, param: 4 })], [{ effect: 0x01, param: 0 }]], 12);
    for (let t = 1; t < 6; t++) expect(ticks[t]!.freq).toBeCloseTo(freqOf(428 - 4 * t), 3);
    // Tick 0 of the next row does not slide; 100 continues at 4.
    expect(ticks[6]!.freq).toBeCloseTo(freqOf(428 - 20), 3);
    expect(ticks[7]!.freq).toBeCloseTo(freqOf(428 - 24), 3);
  });

  it('slides down with 2xx and remembers the speed', () => {
    const { ticks } = play([[note({ effect: 0x02, param: 3 })], [{ effect: 0x02, param: 0 }]], 8);
    expect(ticks[5]!.freq).toBeCloseTo(freqOf(428 + 15), 3);
    expect(ticks[7]!.freq).toBeCloseTo(freqOf(428 + 18), 3);
  });

  it('slides four times as far on a linear table', () => {
    const { ticks } = play([[note({ effect: 0x01, param: 4 })]], 4, { linear: true });
    // 4 units of 1/768 octave per tick.
    expect(semitones(ticks[3]!.freq)).toBeCloseTo((12 * 48) / 768, 6);
  });

  it('keeps slides inside the period range', () => {
    const { ticks } = play([[note({ effect: 0x02, param: 0xff })]], 6, { speed: 31, linear: true });
    // Linear periods stop at 7680, ten octaves below C-4... five octaves down from period 4608.
    expect(semitones(ticks[5]!.freq)).toBeCloseTo((-12 * (7680 - 4608)) / 768, 6);
  });

  it('slides to the note with 3xx and stops there', () => {
    const target = 428 * 2 ** (-2 / 12);
    const { ticks } = play([[note()], [{ note: C4 + 2, effect: 0x03, param: 16 }], [{ effect: 0x03, param: 0 }]], 14);
    expect(ticks[7]!.freq).toBeCloseTo(freqOf(412), 3);
    expect(ticks[8]!.freq).toBeCloseTo(freqOf(396), 3);
    expect(ticks[9]!.freq).toBeCloseTo(freqOf(target), 3);
    expect(ticks[13]!.freq).toBeCloseTo(freqOf(target), 3);
  });

  it('slides to the note from the volume column', () => {
    const { ticks } = play([[note()], [{ note: C4 - 1, volume: 0xf1 }]], 9);
    expect(ticks[7]!.freq).toBeCloseTo(freqOf(444), 3);
    expect(ticks[8]!.freq).toBeCloseTo(freqOf(428 * 2 ** (1 / 12)), 3);
  });

  it('starts the note instead when nothing is playing', () => {
    const { ticks } = play([[], [{ note: C4 + 12, instrument: 1, effect: 0x03, param: 1 }]], 8);
    expect(ticks[7]!.freq).toBeCloseTo(BASE * 2, 3);
  });

  it('runs vibrato with 4xy, from the volume column too', () => {
    const depth = (d: number) => (255 * d) / 128;
    const fx = play([[note({ effect: 0x04, param: 0x88 })], [{ effect: 0x04, param: 0 }]], 10).ticks;
    expect(fx[1]!.freq).toBeCloseTo(BASE, 3);
    // Speed 8 reaches the top of the sine on the third tick.
    expect(fx[3]!.freq).toBeCloseTo(freqOf(428 + depth(8)), 3);
    // The next row reaches the bottom of the wave.
    expect(fx[8]!.freq).toBeCloseTo(freqOf(428 - depth(8)), 3);

    const vol = play([[note({ volume: 0xa8 })], [{ volume: 0xb8 }]], 10).ticks;
    expect(vol[9]!.freq).toBeCloseTo(freqOf(428 + depth(8)), 3);
  });

  it('switches the vibrato wave with E4x', () => {
    const { ticks } = play([[note({ effect: 0x0e, param: 0x42 })], [{ effect: 0x04, param: 0x14 }]], 9);
    // Square wave: full depth from the first step.
    expect(ticks[7]!.freq).toBeCloseTo(freqOf(428 + (255 * 4) / 128), 3);
    expect(ticks[8]!.freq).toBeCloseTo(freqOf(428 + (255 * 4) / 128), 3);
  });

  it('plays arpeggio as base, x, y', () => {
    const { ticks } = play([[note({ effect: 0x00, param: 0x47 })]], 6);
    expect([1, 2, 3, 4, 5].map((t) => Math.round(semitones(ticks[t]!.freq)))).toEqual([4, 7, 0, 4, 7]);
  });

  it('slides finely with E1x and E2x on the first tick only', () => {
    const up = play([[note({ effect: 0x0e, param: 0x14 })], [{ effect: 0x0e, param: 0x10 }]], 8).ticks;
    expect(up[1]!.freq).toBeCloseTo(freqOf(424), 3);
    expect(up[5]!.freq).toBeCloseTo(freqOf(424), 3);
    // E10 repeats the last fine slide.
    expect(up[7]!.freq).toBeCloseTo(freqOf(420), 3);
    const down = play([[note({ effect: 0x0e, param: 0x23 })]], 3).ticks;
    expect(down[2]!.freq).toBeCloseTo(freqOf(431), 3);
  });

  it('slides extra finely with X1y and X2y', () => {
    const up = play([[note({ effect: 0x21, param: 0x12 })], [{ effect: 0x21, param: 0x10 }]], 8).ticks;
    expect(up[1]!.freq).toBeCloseTo(freqOf(427.5), 3);
    expect(up[7]!.freq).toBeCloseTo(freqOf(427), 3);
    const down = play([[note({ effect: 0x21, param: 0x24 })], [{ effect: 0x21, param: 0x20 }]], 8).ticks;
    expect(down[7]!.freq).toBeCloseTo(freqOf(430), 3);
    const linear = play([[note({ effect: 0x21, param: 0x18 })]], 2, { linear: true }).ticks;
    expect(semitones(linear[1]!.freq)).toBeCloseTo((12 * 8) / 768, 6);
  });

  it('sets the finetune with E5x', () => {
    const { ticks } = play([[note({ effect: 0x0e, param: 0x5f })]], 2);
    expect(semitones(ticks[1]!.freq)).toBeCloseTo((7 * 16) / 128, 6);
  });

  it('runs the instrument auto-vibrato, with sweep', () => {
    const ins = dcInstrument({ vibratoDepth: 8, vibratoRate: 64 });
    const plain = play([[note()]], 4, { instruments: [ins] }).ticks;
    const delta = (255 * 8) / 64 / 4;
    expect(plain[1]!.freq).toBeCloseTo(freqOf(428 + delta), 3);
    expect(plain[3]!.freq).toBeCloseTo(freqOf(428 - delta), 3);
    const swept = play([[note()]], 2, { instruments: [{ ...ins, vibratoSweep: 4 }] }).ticks;
    expect(swept[1]!.freq).toBeCloseTo(freqOf(428 + delta / 4), 3);
    const linear = play([[note()]], 2, { instruments: [ins], linear: true }).ticks;
    expect(semitones(linear[1]!.freq)).toBeCloseTo((-12 * delta * 4) / 768, 6);
  });
});

describe('compat playback: volume', () => {
  it('sets the volume from the volume column and Cxx', () => {
    expect(play([[note({ volume: 0x30 })]], 1).ticks[0]!.level).toBeCloseTo(0.5, 6);
    expect(play([[note({ volume: 0x50 })]], 1).ticks[0]!.level).toBeCloseTo(1, 6);
    expect(play([[note({ effect: 0x0c, param: 0x10 })]], 1).ticks[0]!.level).toBeCloseTo(0.25, 6);
    expect(play([[note({ effect: 0x0c, param: 0xff })]], 1).ticks[0]!.level).toBeCloseTo(1, 6);
  });

  it('slides the volume with Axy and remembers it', () => {
    const { ticks } = play(
      [[note({ volume: 0x30, effect: 0x0a, param: 0x20 })], [{ effect: 0x0a, param: 0 }], [{ effect: 0x0a, param: 0x04 }]],
      18,
    );
    expect(ticks[5]!.level).toBeCloseTo(42 / 64, 6);
    expect(ticks[11]!.level).toBeCloseTo(52 / 64, 6);
    expect(ticks[17]!.level).toBeCloseTo(32 / 64, 6);
  });

  it('slides with the volume column and finely on the first tick', () => {
    const v = (rows: ProbeSong['rows'], t: number) => play(rows, t + 1).ticks[t]!.level * 64;
    expect(v([[note({ volume: 0x63 })]], 5)).toBeCloseTo(64 - 15, 4);
    expect(v([[note({ effect: 0x0c, param: 0 })], [{ volume: 0x72 }]], 11)).toBeCloseTo(10, 4);
    expect(v([[note({ volume: 0x85 })]], 5)).toBeCloseTo(59, 4);
    expect(v([[note({ effect: 0x0c, param: 0 })], [{ volume: 0x93 }]], 11)).toBeCloseTo(3, 4);
  });

  it('slides finely with EAx and EBx, and repeats the last one with a zero', () => {
    const { ticks } = play(
      [[note({ volume: 0x30, effect: 0x0e, param: 0xa4 })], [{ effect: 0x0e, param: 0xa0 }], [{ effect: 0x0e, param: 0xb8 }], [{ effect: 0x0e, param: 0xb0 }]],
      24,
    );
    expect(ticks[5]!.level * 64).toBeCloseTo(36, 4);
    expect(ticks[11]!.level * 64).toBeCloseTo(40, 4);
    expect(ticks[17]!.level * 64).toBeCloseTo(32, 4);
    expect(ticks[23]!.level * 64).toBeCloseTo(24, 4);
  });

  it('combines tone portamento and vibrato with a volume slide (5xy, 6xy)', () => {
    // 5xy keeps sliding at the speed of the last 3xx.
    const porta = play([[note()], [{ note: C4 + 12, effect: 0x03, param: 4 }], [{ effect: 0x05, param: 0x02 }]], 14).ticks;
    expect(porta[13]!.level * 64).toBeCloseTo(62, 4);
    expect(porta[13]!.freq).toBeCloseTo(freqOf(428 - 4 * 6), 3);
    const vib = play([[note({ effect: 0x04, param: 0x88 })], [{ effect: 0x06, param: 0x02 }]], 9).ticks;
    expect(vib[8]!.level * 64).toBeCloseTo(60, 4);
    expect(vib[8]!.freq).not.toBeCloseTo(BASE, 0);
  });

  it('runs tremolo with 7xy and E7x picks its wave', () => {
    const sine = play([[note({ volume: 0x30, effect: 0x07, param: 0x88 })], [{ effect: 0x07, param: 0 }]], 8).ticks;
    expect(sine[1]!.level * 64).toBeCloseTo(32, 4);
    expect(sine[3]!.level * 64).toBeCloseTo(32 + (255 * 8) / 64, 4);
    expect(sine[7]!.level * 64).toBeCloseTo(32 - (180 * 8) / 64, 4);
    const square = play([[note({ volume: 0x30, effect: 0x0e, param: 0x72 })], [{ effect: 0x07, param: 0x14 }]], 8).ticks;
    expect(square[7]!.level * 64).toBeCloseTo(32 + (255 * 4) / 64, 4);
  });

  it('cuts with ECx on its tick, EC0 at once', () => {
    const late = play([[note({ effect: 0x0e, param: 0xc2 })]], 3).ticks;
    expect(late.map((t) => t.level)).toEqual([1, 1, 0]);
    expect(play([[note({ effect: 0x0e, param: 0xc0 })]], 1).ticks[0]!.level).toBe(0);
  });

  it('keys off with Kxx on its tick, K00 at once', () => {
    const late = play([[note({ effect: 0x14, param: 3 })]], 4).ticks;
    expect(late.map((t) => t.level)).toEqual([1, 1, 1, 0]);
    expect(play([[note({ effect: 0x14, param: 0 })]], 1).ticks[0]!.level).toBe(0);
  });

  it('turns the sound on and off with tremor', () => {
    const { ticks } = play([[note({ effect: 0x1d, param: 0x21 })], [{ effect: 0x1d, param: 0 }]], 12);
    // Three ticks on, two off, counted from the note.
    expect(ticks.slice(1, 6).map((t) => t.level)).toEqual([1, 1, 1, 0, 0]);
    expect(ticks.slice(7, 12).map((t) => t.level)).toEqual([1, 1, 1, 0, 0]);
  });

  it('sets and slides the global volume (Gxx, Hxy)', () => {
    const up = play([[note({ effect: 0x10, param: 0x20 })], [{ effect: 0x11, param: 0x30 }], [{ effect: 0x11, param: 0 }]], 18).ticks;
    expect(up[0]!.level).toBeCloseTo(0.5, 6);
    expect(up[11]!.level).toBeCloseTo(47 / 64, 6);
    expect(up[17]!.level).toBeCloseTo(62 / 64, 6);
    const down = play([[note()], [{ effect: 0x11, param: 0x05 }]], 12).ticks;
    expect(down[11]!.level).toBeCloseTo(39 / 64, 6);
  });

  it('starts from the song global and channel volumes', () => {
    const song = probeSong({ compat: 'it', rows: [[note()]] });
    song.initialGlobalVolume = 32;
    song.channelVolume = [32];
    expect(probe(song, 1).ticks[0]!.level).toBeCloseTo(0.25, 6);
  });

  it('sets and slides the channel volume (Mxx, Nxy, fine NxF and NFy)', () => {
    const { ticks } = play(
      [
        [note({ effect: 0x16, param: 0x20 })],
        [{ effect: 0x17, param: 0x20 }],
        [{ effect: 0x17, param: 0x03 }],
        [{ effect: 0x17, param: 0x4f }],
        [{ effect: 0x17, param: 0xf8 }],
        [{ effect: 0x17, param: 0 }],
      ],
      36,
    );
    expect(ticks[0]!.level).toBeCloseTo(0.5, 6);
    expect(ticks[11]!.level * 64).toBeCloseTo(42, 4);
    expect(ticks[17]!.level * 64).toBeCloseTo(27, 4);
    expect(ticks[23]!.level * 64).toBeCloseTo(31, 4);
    expect(ticks[29]!.level * 64).toBeCloseTo(23, 4);
    // N00 repeats the fine slide down on tick 0 only.
    expect(ticks[35]!.level * 64).toBeCloseTo(15, 4);
  });
});

describe('compat playback: multi retrigger', () => {
  const after: Record<number, number> = {
    0x0: 32, 0x1: 31, 0x2: 30, 0x3: 28, 0x4: 24, 0x5: 16, 0x6: 21, 0x7: 16,
    0x8: 32, 0x9: 33, 0xa: 34, 0xb: 36, 0xc: 40, 0xd: 48, 0xe: 48, 0xf: 64,
  };
  for (const [x, volume] of Object.entries(after)) {
    it(`changes the volume to ${volume} with R${Number(x).toString(16).toUpperCase()}3`, () => {
      const { ticks, player } = play([[note({ volume: 0x30, effect: 0x1b, param: (Number(x) << 4) | 3 })]], 4);
      expect(ticks[2]!.level * 64).toBeCloseTo(32, 4);
      expect(ticks[3]!.level * 64).toBeCloseTo(volume, 4);
      // Restarted on tick 3: one tick into the sample.
      expect(player.voices()[0]!.pos).toBeCloseTo(BASE / 50, 6);
    });
  }

  it('keeps the interval from the last Rxy', () => {
    // Restarted on tick 2 of the second row, two ticks before the end.
    const { player } = play([[note({ effect: 0x1b, param: 0x02 })], [{ effect: 0x1b, param: 0 }]], 10);
    expect(player.voices()[0]!.pos).toBeCloseTo((2 * BASE) / 50, 6);
  });
});

describe('compat playback: panning', () => {
  const pan = (t: { left: number; right: number }) => Math.round((255 * t.right ** 2) / (t.left ** 2 + t.right ** 2));

  it('sets panning with 8xx, E8x and the volume column', () => {
    expect(pan(play([[note({ effect: 0x08, param: 0 })]], 1).ticks[0]!)).toBe(0);
    expect(pan(play([[note({ effect: 0x08, param: 0xff })]], 1).ticks[0]!)).toBe(255);
    expect(pan(play([[note({ effect: 0x0e, param: 0x83 })]], 1).ticks[0]!)).toBe(51);
    expect(pan(play([[note({ volume: 0xc4 })]], 1).ticks[0]!)).toBe(64);
  });

  it('slides panning with Pxy and the volume column', () => {
    expect(pan(play([[note({ effect: 0x19, param: 0xf0 })]], 6).ticks[5]!)).toBe(128 + 75);
    expect(pan(play([[note({ effect: 0x19, param: 0x0f })], [{ effect: 0x19, param: 0 }]], 8).ticks[7]!)).toBe(128 - 6 * 15);
    expect(pan(play([[note({ volume: 0xd8 })]], 6).ticks[5]!)).toBe(128 - 40);
    expect(pan(play([[note({ volume: 0xe8 })]], 6).ticks[5]!)).toBe(128 + 40);
  });

  it('follows the panning envelope', () => {
    const ins = dcInstrument({ panningEnvelope: env([[0, 0]]) });
    expect(pan(play([[note()]], 1, { instruments: [ins] }).ticks[0]!)).toBe(0);
  });

  it('leaves the channel panning alone for samples without one', () => {
    const ins = dcInstrument();
    ins.samples[0]!.panning = 0;
    ins.samples[0]!.usePanning = false;
    expect(pan(play([[note()]], 1, { instruments: [ins] }).ticks[0]!)).toBe(128);
    ins.samples[0]!.usePanning = true;
    expect(pan(play([[note()]], 1, { instruments: [ins] }).ticks[0]!)).toBe(0);
  });
});

describe('compat playback: notes and envelopes', () => {
  it('delays the note with EDx', () => {
    const { ticks } = play([[note({ effect: 0x0e, param: 0xd2 })]], 4);
    expect(ticks.map((t) => t.level)).toEqual([0, 0, 1, 1]);
  });

  it('retriggers with E9x every x ticks, and E90 on a row without a note', () => {
    const e9 = play([[note({ effect: 0x0e, param: 0x92 })]], 5);
    expect(e9.player.voices()[0]!.pos).toBeCloseTo(BASE / 50, 6);
    const e90 = play([[note()], [{ effect: 0x0e, param: 0x90 }]], 7);
    expect(e90.player.voices()[0]!.pos).toBeCloseTo(BASE / 50, 6);
  });

  it('starts at the sample offset with 9xx', () => {
    const { player } = play([[note({ effect: 0x09, param: 0x01 })]], 1);
    expect(player.voices()[0]!.pos).toBeCloseTo(256 + BASE / 50, 6);
  });

  it('wraps an offset past the end into the loop, or stops a one-shot sample', () => {
    const looped = dcInstrument({}, true, 1000);
    expect(play([[note({ effect: 0x09, param: 0x10 })]], 1, { instruments: [looped] }).ticks[0]!.level).toBe(1);
    const oneShot = dcInstrument({}, false, 1000);
    expect(play([[note({ effect: 0x09, param: 0x10 })]], 1, { instruments: [oneShot] }).ticks[0]!.level).toBe(0);
  });

  it('stays silent for a missing or empty instrument', () => {
    expect(play([[note({ instrument: 2 })]], 1).ticks[0]!.level).toBe(0);
    const empty = dcInstrument({}, false, 0);
    expect(play([[note()]], 1, { instruments: [empty] }).ticks[0]!.level).toBe(0);
  });

  it('cuts a note on key off without a volume envelope', () => {
    const { ticks } = play([[note()], [{ note: NOTE_KEY_OFF }]], 7);
    expect(ticks[5]!.level).toBe(1);
    expect(ticks[6]!.level).toBe(0);
  });

  it('fades out after key off with a volume envelope', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 64]], { sustain: true }), fadeout: 4096 });
    const { ticks } = play([[note()], [{ note: NOTE_KEY_OFF }]], 10, { instruments: [ins] });
    expect(ticks[5]!.level).toBe(1);
    expect(ticks.slice(6, 10).map((t) => t.level * 8)).toEqual([7, 6, 5, 4]);
  });

  it('waits for the envelope to end before fading out (IT)', () => {
    const ins = dcInstrument({
      volumeEnvelope: env([[0, 64], [4, 32]], { sustain: true }),
      fadeout: 4096,
      fadeAfterEnvelope: true,
    });
    const { ticks } = play([[note()], [{ note: NOTE_KEY_OFF }]], 11, { instruments: [ins] });
    // Held at the sustain point until key off, then down the envelope, then fading.
    expect(ticks[5]!.level).toBe(1);
    expect(ticks.slice(6, 11).map((t) => t.level * 64)).toEqual([64, 56, 48, (40 * 7) / 8, (32 * 6) / 8]);
  });

  it('loops the volume envelope', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 64], [2, 0]], { loop: true, loopStart: 0, loopEnd: 1 }) });
    const { ticks } = play([[note()]], 4, { instruments: [ins] });
    expect(ticks.map((t) => t.level)).toEqual([1, 0.5, 1, 0.5]);
  });

  it('jumps in the envelope with Lxx', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 64], [10, 0]], { sustain: true, sustainPoint: 1 }) });
    const { ticks } = play([[note({ effect: 0x15, param: 5 })]], 1, { instruments: [ins] });
    expect(ticks[0]!.level).toBeCloseTo(0.5, 6);
  });

  it('restarts the envelope on a new instrument without a note', () => {
    const ins = dcInstrument({ volumeEnvelope: env([[0, 64], [6, 0]]) });
    const { ticks } = play([[note()], [{ instrument: 1 }]], 7, { instruments: [ins] });
    expect(ticks[5]!.level).toBeCloseTo(64 / 6 / 64, 6);
    expect(ticks[6]!.level).toBe(1);
  });
});

describe('compat playback: sequencing', () => {
  const rowsOf = (p: ReturnType<typeof play>) => p.rows.map((r) => `${r.order}:${r.row}@${r.tick}`);

  it('jumps to an order with Bxx and counts the loop when it goes back', () => {
    const p = play([[{ effect: 0x0b, param: 1 }]], 7, { patterns: 2, orders: [0, 1] });
    expect(rowsOf(p).slice(0, 2)).toEqual(['0:0@0', '1:0@6']);
    const back = play([[{ effect: 0x0b, param: 0 }]], 13);
    expect(back.player.loops).toBe(2);
  });

  it('breaks to a row of the next order with Dxx', () => {
    const p = play([[{ effect: 0x0d, param: 0x12 }]], 7, { patterns: 2, orders: [0, 1] });
    expect(rowsOf(p)).toEqual(['0:0@0', '1:12@6']);
    // Past the end of the next pattern it starts at the top.
    const far = play([[{ effect: 0x0d, param: 0x63 }]], 7, { patterns: 2, orders: [0, 1] });
    expect(rowsOf(far)[1]).toBe('1:0@6');
  });

  it('wraps to the restart position after the last order', () => {
    const p = play([[{ effect: 0x0d, param: 0 }]], 13, { orders: [0, 0] });
    const s = p.player.song;
    expect(s.restartPosition).toBe(0);
    expect(rowsOf(p)).toEqual(['0:0@0', '1:0@6', '0:0@12']);
    expect(p.player.loops).toBe(1);
  });

  it('repeats rows with E6x', () => {
    const p = play([[], [{ effect: 0x0e, param: 0x60 }], [{ effect: 0x0e, param: 0x62 }]], 6 * 8);
    expect(p.rows.map((r) => r.row)).toEqual([0, 1, 2, 1, 2, 1, 2, 3]);
  });

  it('holds a row for extra rows with EEx', () => {
    const p = play([[note({ effect: 0x0e, param: 0xe2 })]], 19);
    expect(rowsOf(p)).toEqual(['0:0@0', '0:1@18']);
  });

  it('sets speed and tempo with Fxx', () => {
    const fast = play([[{ effect: 0x0f, param: 3 }]], 4);
    expect(rowsOf(fast)).toEqual(['0:0@0', '0:1@3']);
    const slow = play([[{ effect: 0x0f, param: 0x40 }]], 6);
    expect(slow.player.tempo).toBe(64);
    expect(play([[{ effect: 0x0f, param: 0 }]], 1).player.speed).toBe(6);
  });

  it('repeats the pattern when told to', () => {
    const p = play([], 6 * 17, { patternRows: 16, patterns: 2, orders: [0, 1] }).rows;
    expect(p.at(-1)).toMatchObject({ order: 1, row: 0 });
    const looped = probe(probeSong({ compat: 's3m', rows: [[{ effect: 0x0d, param: 0 }]], patterns: 2, orders: [0, 1] }), 13, (pl) => {
      pl.loopPattern = true;
    });
    expect(looped.rows.map((r) => r.order)).toEqual([0, 0, 0]);
  });
});
