import { describe, expect, it } from 'vitest';
import { createSong } from './edit.ts';
import { Player } from './player.ts';

const RATE = 48000;

function render(player: Player, frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  player.process(left, right);
  return left;
}

const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('preview voice', () => {
  it('plays an instrument while the song is stopped', () => {
    const player = new Player(createSong(4), RATE);
    expect(peak(render(player, 1024))).toBe(0);
    player.previewNote(1, 49);
    const out = render(player, RATE / 2);
    expect(peak(out)).toBeGreaterThan(0.05);
    let rising = 0;
    for (let i = 2001; i < out.length; i++) if (out[i - 1]! <= 0 && out[i]! > 0) rising++;
    const hz = (rising * RATE) / (out.length - 2001);
    expect(hz).toBeGreaterThan(250);
    expect(hz).toBeLessThan(272);
  });

  it('goes quiet after note off', () => {
    const player = new Player(createSong(4), RATE);
    player.previewNote(1, 49);
    render(player, 4800);
    player.previewOff();
    render(player, 4800);
    expect(peak(render(player, 4800))).toBeLessThan(1e-6);
  });

  it('follows the volume envelope and fadeout after release', () => {
    const song = createSong(4);
    const ins = song.instruments[0]!;
    ins.volumeEnvelope = { enabled: true, points: [{ x: 0, y: 64 }, { x: 10, y: 64 }], sustain: true, sustainPoint: 1, loop: false, loopStart: 0, loopEnd: 0 };
    ins.fadeout = 4096;
    const player = new Player(song, RATE);
    player.previewNote(1, 49);
    const held = peak(render(player, RATE / 2));
    player.previewOff();
    render(player, RATE / 4);
    const released = peak(render(player, 4800));
    expect(held).toBeGreaterThan(0.05);
    expect(released).toBeLessThan(held / 100);
  });

  it('does not stop the song or its channels', () => {
    const player = new Player(createSong(4), RATE);
    player.playing = true;
    player.previewNote(2, 61);
    render(player, 4800);
    expect(player.getState().playing).toBe(true);
  });
});
