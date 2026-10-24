import { describe, expect, it } from 'vitest';
import { createSong, Player, writeCell } from './index.ts';

describe('Player scopes', () => {
  it('records each channel separately, oldest frame first', () => {
    const song = createSong();
    writeCell(song, song.patterns[0]!, 0, 1, { note: 49, instrument: 1 });
    const player = new Player(song, 48000);
    player.enableScopes(1024);
    player.playing = true;
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    for (let i = 0; i < 40; i++) player.process(left, right);

    const scopes = player.readScopes();
    expect(scopes).toHaveLength(4);
    expect(scopes[1]!).toHaveLength(1024);
    expect(scopes[0]!.every((v) => v === 0)).toBe(true);
    expect(Math.max(...scopes[1]!)).toBeGreaterThan(0.05);
    expect(Math.min(...scopes[1]!)).toBeLessThan(-0.05);
  });

  it('defaults new songs to four channels', () => {
    expect(createSong().channels).toBe(4);
  });
});

describe('Player voices', () => {
  it('reports the preview voice until it is released', () => {
    const song = createSong();
    const player = new Player(song, 48000);
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    player.previewNote(1, 49);
    for (let i = 0; i < 20; i++) player.process(left, right);
    const [voice] = player.voices();
    expect(voice).toMatchObject({ channel: -1, instrument: 1, sample: 0, note: 49 });
    expect(voice!.pos).toBeGreaterThan(0);
    player.previewOff();
    for (let i = 0; i < 400; i++) player.process(left, right);
    expect(player.voices()).toHaveLength(0);
  });
});
