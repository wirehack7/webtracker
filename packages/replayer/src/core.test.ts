import { describe, expect, it } from 'vitest';
import { createDemoSong, type Song } from '@webtracker/engine';
import { ReplayerCore, DEFAULT_MIXER } from './core.ts';
import type { ReplayerEvent } from './messages.ts';

const RATE = 8000;
const BLOCK = 128;

/** A copy of the demo song cut down to its first order, so it ends quickly. */
function shortSong(): Song {
  const song = createDemoSong();
  song.orders = song.orders.slice(0, 1);
  song.restartPosition = 0;
  return song;
}

function run(core: ReplayerCore, blocks: number, start = 0): number {
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  let peak = 0;
  for (let b = 0; b < blocks; b++) {
    core.process(left, right, BLOCK, start + (b * BLOCK) / RATE);
    for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  }
  return peak;
}

describe('ReplayerCore', () => {
  it('reports rows in order with growing song time, and the end without loop', () => {
    const events: ReplayerEvent[] = [];
    const core = new ReplayerCore(RATE, (e) => events.push(e));
    const song = shortSong();
    core.handle({ type: 'song', song });
    core.handle({ type: 'mixer', settings: { ...DEFAULT_MIXER, loop: false } });
    expect(run(core, 10)).toBe(0);
    core.handle({ type: 'play' });
    run(core, Math.ceil((RATE * 60) / BLOCK));
    const rows = events.filter((e) => e.type === 'row');
    const rowCount = song.patterns[song.orders[0]!]!.rows;
    expect(rows.map((e) => e.state.row)).toEqual(Array.from({ length: rowCount }, (_, i) => i));
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.songTime).toBeGreaterThan(rows[i - 1]!.songTime);
    expect(rows[1]!.when).toBeGreaterThan(rows[0]!.when);
    expect(events.at(-1)?.type).toBe('end');
    // After the end it is silent until played again, from the start.
    expect(run(core, 20)).toBe(0);
    events.length = 0;
    core.handle({ type: 'play' });
    run(core, 1);
    expect(events[0]).toMatchObject({ type: 'row', state: { order: 0, row: 0 }, songTime: 0 });
  });

  it('keeps going with loop on, and seeks', () => {
    const events: ReplayerEvent[] = [];
    const core = new ReplayerCore(RATE, (e) => events.push(e));
    core.handle({ type: 'song', song: shortSong() });
    core.handle({ type: 'play' });
    run(core, Math.ceil((RATE * 60) / BLOCK));
    expect(events.some((e) => e.type === 'end')).toBe(false);
    expect(events.filter((e) => e.type === 'row' && e.state.row === 0).length).toBeGreaterThan(1);
    events.length = 0;
    core.handle({ type: 'seek', order: 0, row: 8 });
    run(core, 1);
    expect(events[0]).toMatchObject({ type: 'row', state: { row: 8 } });
  });

  it('scales the output with the volume', () => {
    const loud = new ReplayerCore(RATE, () => {});
    const quiet = new ReplayerCore(RATE, () => {});
    for (const [core, volume] of [[loud, 1], [quiet, 0.25]] as const) {
      core.handle({ type: 'song', song: shortSong() });
      core.handle({ type: 'mixer', settings: { ...DEFAULT_MIXER, volume } });
      core.handle({ type: 'play' });
    }
    const a = run(loud, 200);
    const b = run(quiet, 200);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeLessThan(a * 0.5);
  });

  it('sends channel snapshots for scopes only while they are on', () => {
    const events: ReplayerEvent[] = [];
    const core = new ReplayerCore(RATE, (e) => events.push(e));
    const song = shortSong();
    core.handle({ type: 'song', song });
    core.handle({ type: 'play' });
    run(core, 100);
    expect(events.some((e) => e.type === 'scopes')).toBe(false);
    core.handle({ type: 'scopes', frames: 256, rate: 10 });
    run(core, Math.ceil(RATE / BLOCK));
    const snaps = events.filter((e) => e.type === 'scopes');
    // One a tenth of a second, give or take the block size.
    expect(snaps.length).toBeGreaterThanOrEqual(9);
    expect(snaps.length).toBeLessThanOrEqual(11);
    const first = snaps[0]!;
    expect(first.channels).toHaveLength(song.channels);
    expect(first.channels[0]).toHaveLength(256);
    expect(snaps.some((e) => e.channels.some((c) => c.some((v) => v !== 0)))).toBe(true);
    events.length = 0;
    core.handle({ type: 'scopes', frames: 0, rate: 0 });
    run(core, 100);
    expect(events.some((e) => e.type === 'scopes')).toBe(false);
  });
});
