import { describe, expect, it } from 'vitest';
import { type Cell } from './song.ts';
import { dcInstrument, probe, probeSong, type ProbeSong, type Tick } from './test-probe.ts';

/**
 * MOD effects on the ProTracker 2 path, one by one, measured tick by tick.
 * ProTracker's own quirks have their tests in the formats package (pt2.test.ts).
 */

/** C-2 in ProTracker terms (period 428); C-4 in the editor's numbering. */
const C2 = 49;
const PAL = 3546895;
const hz = (period: number) => PAL / period;

const play = (rows: ProbeSong['rows'], ticks: number, opts: Partial<ProbeSong> = {}) =>
  probe(probeSong({ format: 'mod', channels: 4, ...opts, rows }), ticks);
const note = (extra: Partial<Cell> = {}): Partial<Cell> => ({ note: C2, instrument: 1, ...extra });
const vol64 = (t: Tick) => Math.round(t.level * 64 * 1e4) / 1e4;
/** The period heard during each tick, read back from the frequency. */
const periods = (ticks: Tick[], from: number, to: number) => ticks.slice(from, to).map((t) => Math.round(PAL / t.freq));

function half() {
  const ins = dcInstrument();
  ins.samples[0]!.volume = 32;
  return ins;
}

describe('ProTracker path: pitch', () => {
  it('plays C-2 at the PAL clock over period 428', () => {
    expect(play([[note()]], 2).ticks[1]!.freq).toBeCloseTo(hz(428), 3);
  });

  it('slides with 1xx and 2xx and stops at B-3 and C-1', () => {
    expect(periods(play([[note({ effect: 0x01, param: 3 })]], 6).ticks, 1, 6)).toEqual([425, 422, 419, 416, 413]);
    expect(periods(play([[note({ effect: 0x02, param: 3 })]], 6).ticks, 1, 6)).toEqual([431, 434, 437, 440, 443]);
    expect(periods(play([[note({ effect: 0x01, param: 0x80 })]], 4).ticks, 1, 4)).toEqual([300, 172, 113]);
    expect(periods(play([[note({ effect: 0x02, param: 0xff })]], 3).ticks, 1, 3)).toEqual([683, 856]);
  });

  it('has no slide memory: 100 does nothing', () => {
    const { ticks } = play([[note({ effect: 0x01, param: 2 })], [{ effect: 0x01, param: 0 }]], 9);
    expect(periods(ticks, 6, 9)).toEqual([418, 418, 418]);
  });

  it('slides finely with E1x and E2x on tick 0', () => {
    expect(periods(play([[note({ effect: 0x0e, param: 0x14 })]], 3).ticks, 1, 3)).toEqual([424, 424]);
    expect(periods(play([[note({ effect: 0x0e, param: 0x24 })]], 3).ticks, 1, 3)).toEqual([432, 432]);
  });

  it('slides to the note with 3xx, remembers its speed, and stops there', () => {
    const { ticks } = play([[note()], [{ note: C2 + 2, effect: 0x03, param: 0x10 }], [{ effect: 0x03, param: 0 }]], 14);
    expect(periods(ticks, 7, 10)).toEqual([412, 396, 381]);
    expect(periods(ticks, 12, 14)).toEqual([381, 381]);
    const up = play([[note()], [{ note: C2 - 1, effect: 0x03, param: 0x08 }]], 11);
    expect(periods(up.ticks, 7, 11)).toEqual([436, 444, 452, 453]);
  });

  it('snaps tone portamento to semitones with glissando (E3x)', () => {
    const { ticks } = play([[note({ effect: 0x0e, param: 0x31 })], [{ note: C2 + 2, effect: 0x03, param: 0x10 }]], 9);
    expect(periods(ticks, 7, 9)).toEqual([404, 381]);
  });

  it('plays arpeggio through the period table', () => {
    const { ticks } = play([[note({ effect: 0x00, param: 0x47 })]], 6);
    expect(periods(ticks, 1, 6)).toEqual([339, 285, 428, 339, 285]);
  });

  it('runs vibrato, keeps its speed and depth separately, and picks the wave with E4x', () => {
    const sine = play([[note({ effect: 0x04, param: 0x48 })], [{ effect: 0x04, param: 0x00 }]], 10).ticks;
    expect(periods(sine, 1, 4)).toEqual([428, 428 + ((97 * 8) >> 7), 428 + ((180 * 8) >> 7)]);
    // 400 keeps going at the same speed and depth.
    expect(periods(sine, 7, 10)).toEqual([428 + ((235 * 8) >> 7), 428 + ((180 * 8) >> 7), 428 + ((97 * 8) >> 7)]);
    const square = play([[note({ effect: 0x0e, param: 0x42 })], [{ effect: 0x04, param: 0x48 }]], 8).ticks;
    expect(periods(square, 7, 8)).toEqual([428 + ((255 * 8) >> 7)]);
    const ramp = play([[note({ effect: 0x0e, param: 0x41 })], [{ effect: 0x04, param: 0xf8 }]], 11).ticks;
    expect(periods(ramp, 8, 11)).toEqual([428 + ((15 * 8 * 8) >> 7), 428 + ((30 * 8 * 8) >> 7), 428 - (((255 - 13 * 8) * 8) >> 7)]);
  });

  it('sets the finetune with E5x on the note', () => {
    expect(periods(play([[note({ effect: 0x0e, param: 0x57 })]], 2).ticks, 1, 2)).toEqual([407]);
  });

  it('starts at the sample offset with 9xx in steps of 256 frames', () => {
    const { player } = play([[note({ effect: 0x09, param: 0x02 })]], 1);
    expect(player.voices()[0]!.pos).toBeCloseTo(512 + hz(428) / 50, 3);
  });

  it('keeps silent past the end of a one-shot sample with 9xx', () => {
    const short = dcInstrument({}, false, 1000);
    expect(play([[note({ effect: 0x09, param: 0x10 })]], 1, { instruments: [short] }).ticks[0]!.level).toBe(0);
  });
});

describe('ProTracker path: wide MODs', () => {
  it('plays notes outside three octaves and slides past the Amiga limits', () => {
    const low = 13; // C-0 in ProTracker terms
    expect(periods(play([[note({ note: low })]], 2, { channels: 8 }).ticks, 1, 2)).toEqual([3424]);
    expect(periods(play([[note({ note: low, effect: 0x02, param: 0xff })]], 6, { channels: 8 }).ticks, 5, 6)).toEqual([4699]);
    expect(periods(play([[note({ note: low, effect: 0x02, param: 0xff })]], 15, { channels: 8, speed: 31 }).ticks, 14, 15)).toEqual([6848]);
    expect(periods(play([[note({ effect: 0x01, param: 0xff })]], 3, { channels: 8 }).ticks, 2, 3)).toEqual([14]);
  });

  it('runs arpeggio and tone portamento outside the table', () => {
    const low = 13;
    const arp = play([[note({ note: low, effect: 0x00, param: 0x0c })]], 3, { channels: 8 }).ticks;
    expect(periods(arp, 2, 3)).toEqual([1712]);
    const rows = [[note()], [{ note: low, effect: 0x03, param: 0xff }], [{ effect: 0x03 }], [{ effect: 0x03 }]];
    const porta = play(rows, 24, { channels: 8 }).ticks;
    expect(periods(porta, 11, 12)).toEqual([428 + 5 * 255]);
    expect(periods(porta, 23, 24)).toEqual([3424]);
  });

  it('applies the finetune to notes outside the table', () => {
    expect(periods(play([[note({ note: 13, effect: 0x0e, param: 0x5f })]], 2, { channels: 8 }).ticks, 1, 2)).toEqual([3449]);
  });
});

describe('ProTracker path: volume', () => {
  it('sets the volume with Cxx and from an editor volume column', () => {
    expect(vol64(play([[note({ effect: 0x0c, param: 0x20 })]], 1).ticks[0]!)).toBe(32);
    expect(vol64(play([[note({ effect: 0x0c, param: 0x7f })]], 1).ticks[0]!)).toBe(64);
    expect(vol64(play([[note({ volume: 0x18 })]], 1).ticks[0]!)).toBe(8);
  });

  it('slides with Axy; the slide down wins when both nibbles are set', () => {
    expect(vol64(play([[note({ effect: 0x0a, param: 0x03 })]], 6).ticks[5]!)).toBe(49);
    expect(vol64(play([[note({ effect: 0x0a, param: 0x30 })]], 6, { instruments: [half()] }).ticks[5]!)).toBe(47);
  });

  it('combines 5xy and 6xy with the volume slide', () => {
    const porta = play([[note()], [{ note: C2 + 12, effect: 0x03, param: 4 }], [{ effect: 0x05, param: 0x02 }]], 14).ticks;
    expect(vol64(porta[13]!)).toBe(62);
    expect(periods(porta, 13, 14)).toEqual([428 - 4 * 6]);
    const vib = play([[note({ effect: 0x04, param: 0x48 })], [{ effect: 0x06, param: 0x02 }]], 9).ticks;
    expect(vol64(vib[8]!)).toBe(60);
    expect(periods(vib, 8, 9)).toEqual([428 + ((180 * 8) >> 7)]);
  });

  it('slides finely with EAx and EBx', () => {
    expect(vol64(play([[note({ effect: 0x0e, param: 0xa4 })]], 3, { instruments: [half()] }).ticks[2]!)).toBe(36);
    expect(vol64(play([[note({ effect: 0x0e, param: 0xb4 })]], 3).ticks[2]!)).toBe(60);
  });

  it('cuts with ECx on its tick', () => {
    expect(play([[note({ effect: 0x0e, param: 0xc2 })]], 3).ticks.map(vol64)).toEqual([64, 64, 0]);
  });

  it('runs tremolo, and its ramp follows the vibrato position', () => {
    const sine = play([[note({ effect: 0x07, param: 0x48 })], [{ effect: 0x07, param: 0 }]], 8, { instruments: [half()] }).ticks;
    expect(sine.slice(1, 4).map(vol64)).toEqual([32, 32 + ((97 * 8) >> 6), 32 + ((180 * 8) >> 6)]);
    expect(vol64(sine[7]!)).toBe(32 + ((235 * 8) >> 6));
    const square = play([[note({ effect: 0x0e, param: 0x72 })], [{ effect: 0x07, param: 0x48 }]], 8, { instruments: [half()] }).ticks;
    expect(vol64(square[7]!)).toBe(32 + ((255 * 8) >> 6));
    const ramp = play([[note({ effect: 0x04, param: 0x80 })], [{ effect: 0x0e, param: 0x71 }], [{ effect: 0x07, param: 0x48 }]], 15, {
      instruments: [half()],
    }).ticks;
    expect(vol64(ramp[14]!)).toBe(32 + (((255 - 32) * 8) >> 6));
    // Past half way the tremolo turns down.
    const down = play([[note({ effect: 0x07, param: 0xf8 })]], 5, { instruments: [half()] }).ticks;
    expect(vol64(down[4]!)).toBe(32 - ((PT_VIB_AT_13 * 8) >> 6));
  });
});

/** Entry 13 of ProTracker's half sine. */
const PT_VIB_AT_13 = 244;

describe('ProTracker path: notes', () => {
  it('retriggers with E9x on the ticks it names', () => {
    const { player } = play([[note({ effect: 0x0e, param: 0x92 })]], 5);
    expect(player.voices()[0]!.pos).toBeCloseTo(hz(428) / 50, 3);
    // Without a note, tick 0 retriggers too.
    const noNote = play([[note()], [{ effect: 0x0e, param: 0x93 }]], 7);
    expect(noNote.player.voices()[0]!.pos).toBeCloseTo(hz(428) / 50, 3);
  });

  it('delays a note with EDx', () => {
    expect(play([[note({ effect: 0x0e, param: 0xd2 })]], 3).ticks.map(vol64)).toEqual([0, 0, 64]);
  });

  it('silences the channel with an empty sample slot', () => {
    const empty = dcInstrument({}, false, 0);
    expect(play([[note()], [{ note: C2, instrument: 2 }]], 7, { instruments: [dcInstrument(), empty] }).ticks[6]!.level).toBe(0);
  });

  it('switches the LED filter with E00 and E01', () => {
    expect(play([[{ effect: 0x0e, param: 0x00 }]], 1).player.ledFilter).toBe(true);
    expect(play([[{ effect: 0x0e, param: 0x00 }], [{ effect: 0x0e, param: 0x01 }]], 7).player.ledFilter).toBe(false);
  });
});

describe('ProTracker path: sequencing', () => {
  const rowsOf = (p: ReturnType<typeof play>) => p.rows.map((r) => `${r.order}:${r.row}@${r.tick}`);

  it('jumps with Bxx and breaks with Dxx, which reads its row as decimal', () => {
    expect(rowsOf(play([[{ effect: 0x0b, param: 1 }]], 7, { patterns: 2, orders: [0, 1] }))).toEqual(['0:0@0', '1:0@6']);
    expect(rowsOf(play([[{ effect: 0x0d, param: 0x12 }]], 7, { patterns: 2, orders: [0, 1] }))).toEqual(['0:0@0', '1:12@6']);
    expect(rowsOf(play([[{ effect: 0x0d, param: 0x64 }]], 7, { patterns: 2, orders: [0, 1] }))).toEqual(['0:0@0', '1:0@6']);
    expect(play([[{ effect: 0x0b, param: 0 }]], 6).player.loops).toBe(1);
  });

  it('wraps past the last order to the restart position', () => {
    const song = probeSong({ format: 'mod', channels: 4, rows: [[{ effect: 0x0d, param: 0 }]], orders: [0, 0, 0] });
    song.restartPosition = 1;
    expect(probe(song, 19).rows.map((r) => r.order)).toEqual([0, 1, 2, 1]);
    song.restartPosition = 5;
    expect(probe(song, 19).rows.map((r) => r.order)).toEqual([0, 1, 2, 0]);
  });

  it('repeats rows with E6x', () => {
    const p = play([[], [{ effect: 0x0e, param: 0x60 }], [{ effect: 0x0e, param: 0x62 }]], 6 * 8);
    expect(p.rows.map((r) => r.row)).toEqual([0, 1, 2, 1, 2, 1, 2, 3]);
  });

  it('delays the pattern with EEx, running effects on the repeats', () => {
    const p = play([[note({ effect: 0x0e, param: 0xe1 })], [note({ effect: 0x0a, param: 0x01 })], [{ effect: 0x0e, param: 0xe1 }]], 14);
    expect(rowsOf(p).slice(0, 2)).toEqual(['0:0@0', '0:1@12']);
  });

  it('sets the speed at once and the tempo one tick late', () => {
    expect(rowsOf(play([[{ effect: 0x0f, param: 2 }]], 3))).toEqual(['0:0@0', '0:1@2']);
    expect(play([[{ effect: 0x0f, param: 0x80 }]], 1).player.tempo).toBe(125);
    expect(play([[{ effect: 0x0f, param: 0x80 }]], 2).player.tempo).toBe(128);
    expect(play([[{ effect: 0x0f, param: 0 }]], 1).player.speed).toBe(6);
  });

  it('plays the same pattern again when told to loop it', () => {
    const song = probeSong({ format: 'mod', channels: 4, rows: [[{ effect: 0x0b, param: 1 }]], patterns: 2, orders: [0, 1] });
    const p = probe(song, 13, (pl) => (pl.loopPattern = true));
    expect(p.rows.map((r) => r.order)).toEqual([0, 0, 0]);
  });
});
