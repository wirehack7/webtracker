import { describe, expect, it } from 'vitest';
import { createSong, ensurePattern, LoopType, writeCell, type Song } from '@webtracker/engine';
import { loadXm } from './xm.ts';
import { saveXm } from './xm-write.ts';
import { buildXm, squareWave } from './test-builders.ts';

const roundTrip = (song: Song) => loadXm(saveXm(song).slice().buffer);

/** The parts of a song that a save and load must keep. */
function essence(song: Song) {
  return {
    title: song.title,
    channels: song.channels,
    orders: song.orders,
    restartPosition: song.restartPosition,
    linearFrequency: song.linearFrequency,
    initialSpeed: song.initialSpeed,
    initialTempo: song.initialTempo,
    patterns: song.patterns.map((p) => ({ rows: p.rows, data: Array.from(p.data) })),
    instruments: song.instruments.map((ins) => ({
      ...ins,
      keymap: Array.from(ins.keymap),
      samples: ins.samples.map((s) => ({ ...s, data: Array.from(s.data) })),
    })),
  };
}

describe('saveXm', () => {
  it('round-trips a new song with notes, effects and the chip instruments', () => {
    const song = createSong(6);
    song.title = 'round trip';
    song.initialSpeed = 3;
    song.initialTempo = 150;
    song.orders = [0, 1, 0];
    song.restartPosition = 1;
    const p1 = ensurePattern(song, 1);
    writeCell(song, song.patterns[0]!, 0, 0, { note: 49, instrument: 1, volume: 0x30, effect: 0xf, param: 3 });
    writeCell(song, p1, 63, 5, { note: 97 });
    // A cell with all five fields set is stored unpacked.
    writeCell(song, p1, 10, 2, { note: 60, instrument: 2, volume: 0x40, effect: 0xa, param: 0x0f });
    expect(essence(roundTrip(song))).toEqual(essence(song));
  });

  it('keeps 16-bit samples, ping-pong loops and envelopes', () => {
    const song = createSong(2);
    const ins = song.instruments[0]!;
    const data = Float32Array.from({ length: 100 }, (_, i) => Math.round(Math.sin(i / 7) * 30000) / 32768);
    ins.samples[0] = { ...ins.samples[0]!, data, loopType: LoopType.PingPong, loopStart: 10, loopLength: 50, finetune: -16, relativeNote: 12, panning: 40 };
    ins.volumeEnvelope = { enabled: true, points: [{ x: 0, y: 64 }, { x: 20, y: 32 }, { x: 40, y: 0 }], sustain: true, sustainPoint: 1, loop: false, loopStart: 0, loopEnd: 0 };
    ins.fadeout = 512;
    ins.keymap[50] = 0;
    expect(essence(roundTrip(song))).toEqual(essence(song));
  });

  it('round-trips a file from the XM builder byte for byte in content', () => {
    const original = loadXm(
      buildXm({
        title: 'builder',
        channels: 4,
        orders: [0, 1],
        patterns: [
          { rows: 32, cells: [[{ note: 49, ins: 1, vol: 0x30 }], [undefined, { eff: 0xf, param: 4 }]] },
          { rows: 16, cells: [] },
        ],
        instruments: [{ samples: [{ data: squareWave(32), loop: 'forward', loopStart: 0, loopLength: 32 }] }],
      }),
    );
    expect(essence(roundTrip(original))).toEqual(essence(original));
  });
});

describe('saveXm with large data', () => {
  it('writes songs bigger than the initial buffer', () => {
    const song = createSong(4);
    // 200000 16-bit frames: 400 kB of sample data, far past the first 64 kB buffer.
    song.instruments[0]!.samples[0]!.data = Float32Array.from({ length: 200000 }, (_, i) => Math.round(Math.sin(i / 50) * 20000) / 32768);
    song.instruments[0]!.samples[0]!.loopLength = 100;
    const back = roundTrip(song);
    expect(Array.from(back.instruments[0]!.samples[0]!.data)).toEqual(Array.from(song.instruments[0]!.samples[0]!.data));
    expect(back.instruments).toHaveLength(song.instruments.length);
  });
});
