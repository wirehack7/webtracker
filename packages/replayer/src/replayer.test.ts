import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoSong, createSong, type Song } from '@webtracker/engine';
import { saveMod, saveXm } from '@webtracker/formats';
import { FakeAudioContext, FakeAudioWorkletNode, peak } from './test-audio.ts';
import { createReplayer, loadSong } from './full.ts';
import * as lite from './lite.ts';
import type { Replayer } from './replayer.ts';

/**
 * The page side of the replayer (replayer.ts) and the worklet around the core
 * (worklet.ts), run together against a fake AudioContext whose clock the test
 * moves. What it cannot show is a real browser's audio thread, which the
 * browser smoke test plays.
 */

/** The demo song cut to its first order, so a run without loop ends quickly. */
function shortSong(): Song {
  const song = createDemoSong();
  song.orders = song.orders.slice(0, 1);
  song.restartPosition = 0;
  return song;
}

const latency = 0.03;
let ctx: FakeAudioContext;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  ctx = new FakeAudioContext();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Plays `seconds` of audio with the page's clock in step, firing callbacks as they come due. */
const advance = (seconds: number, mono = false) => ctx.render(seconds, mono, (s) => vi.advanceTimersByTime(s * 1000));

const make = (options: Parameters<typeof createReplayer>[1] = {}) =>
  createReplayer(shortSong(), { context: ctx as unknown as AudioContext, ...options });

describe('Replayer', () => {
  it('registers the worklet once per context and connects to the speakers', async () => {
    const a = await make();
    const b = await make();
    expect(ctx.modules).toHaveLength(1);
    expect(ctx.modules[0]).toMatch(/^blob:/);
    expect((a.node as unknown as FakeAudioWorkletNode).connectedTo).toBe(ctx.destination);
    expect((b.node as unknown as FakeAudioWorkletNode).options).toMatchObject({ numberOfInputs: 0, outputChannelCount: [2] });
    expect(a.title).toBe(createDemoSong().title);
  });

  it('connects to another node when given one', async () => {
    const destination = { name: 'analyser' } as unknown as AudioNode;
    const r = await make({ destination });
    expect((r.node as unknown as FakeAudioWorkletNode).connectedTo).toBe(destination);
  });

  it('stays silent until play, which resumes a suspended context', async () => {
    const r = await make();
    expect(peak(advance(0.2).left)).toBe(0);
    expect(r.isPlaying).toBe(false);
    await r.play();
    expect(ctx.state).toBe('running');
    expect(r.isPlaying).toBe(true);
    expect(peak(advance(1).left)).toBeGreaterThan(0.01);
  });

  it('reports rows when they are heard, after the output latency', async () => {
    const r = await make();
    const rows: number[] = [];
    r.onRow = (state) => rows.push(state.row);
    await r.play();
    ctx.render(0.01);
    // The first row is rendered at time 0 and heard 30 ms later.
    vi.advanceTimersByTime(latency * 1000 - 1);
    expect(rows).toEqual([]);
    expect(r.position).toBeNull();
    expect(r.time).toBe(0);
    vi.advanceTimersByTime(2);
    expect(rows).toEqual([0]);
    expect(r.position).toMatchObject({ order: 0, row: 0 });
    advance(1);
    expect(rows.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(r.time).toBeGreaterThan(0.9);
  });

  it('holds the time while paused and goes back to the start on stop', async () => {
    const r = await make();
    await r.play();
    advance(1);
    r.pause();
    expect(r.isPlaying).toBe(false);
    const held = r.time;
    advance(0.5);
    expect(r.time).toBeCloseTo(held, 6);
    expect(peak(advance(0.2).left)).toBe(0);
    r.stop();
    expect(r.position).toBeNull();
    expect(r.time).toBe(0);
    const rows: number[] = [];
    r.onRow = (s) => rows.push(s.row);
    await r.play();
    advance(0.2);
    expect(rows[0]).toBe(0);
  });

  it('seeks to an order and row, dropping callbacks still due from before', async () => {
    const r = await make();
    const rows: number[] = [];
    r.onRow = (s) => rows.push(s.row);
    await r.play();
    ctx.render(0.2);
    r.seek(0, 8);
    advance(0.05);
    expect(rows[0]).toBe(8);
  });

  it('ends without loop and calls onEnd when the end is heard', async () => {
    const r = await make({ loop: false });
    expect(r.loop).toBe(false);
    const onEnd = vi.fn();
    r.onEnd = onEnd;
    await r.play();
    advance(30);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(r.isPlaying).toBe(false);
    expect(r.position).toBeNull();
  });

  it('keeps playing with loop on, and loop can change while playing', async () => {
    const r = await make();
    expect(r.loop).toBe(true);
    const onEnd = vi.fn();
    r.onEnd = onEnd;
    await r.play();
    advance(30);
    expect(onEnd).not.toHaveBeenCalled();
    r.loop = false;
    advance(30);
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('changes the volume and other mixer settings', async () => {
    const r = await make({ volume: 0.5 });
    expect(r.volume).toBe(0.5);
    await r.play();
    const half = peak(advance(1).left);
    r.stop();
    r.volume = 1;
    await r.play();
    const full = peak(advance(1).left);
    expect(full).toBeGreaterThan(half * 1.5);
    r.set({ volume: 0 });
    expect(peak(advance(0.5).left)).toBe(0);
  });

  it('plays mono when given mono settings', async () => {
    const r = await make({ stereoSeparation: 0 });
    await r.play();
    const { left, right } = advance(1);
    expect(peak(left)).toBeGreaterThan(0.01);
    expect(Array.from(left)).toEqual(Array.from(right));
  });

  it('mixes down to one output channel', async () => {
    const r = await make();
    await r.play();
    expect(peak(advance(1, true).left)).toBeGreaterThan(0.01);
  });

  it('delivers scopes while they are on', async () => {
    const r = await make();
    await r.play();
    advance(0.5);
    expect(r.scopes).toEqual([]);
    r.enableScopes(512, 20);
    advance(0.5);
    expect(r.scopes).toHaveLength(r.song.channels);
    expect(r.scopes[0]).toHaveLength(512);
    expect(r.scopes.some((c) => c.some((v) => v !== 0))).toBe(true);
    r.enableScopes(0);
    expect(r.scopes).toEqual([]);
    advance(0.5);
    expect(r.scopes).toEqual([]);
  });

  it('lets go of its node on destroy', async () => {
    const r = await make();
    await r.play();
    advance(0.1);
    r.destroy();
    expect(r.isPlaying).toBe(false);
    expect(ctx.nodes).toHaveLength(0);
    expect(r.node.port.onmessage).toBeNull();
  });

  it('makes its own context and asks iOS to play through the silent switch', async () => {
    const audioSession = { type: 'auto' };
    vi.stubGlobal('navigator', { audioSession });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const r: Replayer = await createReplayer(shortSong());
    expect(r.context).toBeInstanceOf(FakeAudioContext);
    expect(audioSession.type).toBe('playback');
  });

  it('leaves a session type the page chose alone', async () => {
    const audioSession = { type: 'ambient' };
    vi.stubGlobal('navigator', { audioSession });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await createReplayer(shortSong());
    expect(audioSession.type).toBe('ambient');
  });
});

describe('loading', () => {
  const xm = () => saveXm(createDemoSong());
  const mod = () => saveMod(createSong(4)).bytes;

  it('takes bytes as a Uint8Array or an ArrayBuffer', async () => {
    expect((await loadSong(xm())).title).toBe(createDemoSong().title);
    expect((await loadSong(xm().slice().buffer)).channels).toBe(createDemoSong().channels);
  });

  it('passes a song through as it is', async () => {
    const song = createDemoSong();
    expect(await loadSong(song)).toBe(song);
  });

  it('fetches a URL and names the module after it', async () => {
    const bytes = mod();
    const fetch = vi.fn(async () => new Response(bytes.slice()));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('location', { href: 'https://example.org/intro/' });
    const song = await loadSong('music/tune.mod');
    expect(fetch).toHaveBeenCalledWith('music/tune.mod');
    expect(song.format).toBe('mod');
  });

  it('says which URL failed', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    await expect(loadSong('https://example.org/missing.xm')).rejects.toThrow('Could not load https://example.org/missing.xm: 404');
  });

  it('plays XM and MOD in the lite build and refuses the rest', async () => {
    expect((await lite.loadSong(xm())).format).toBe('xm');
    expect((await lite.loadSong(mod())).format).toBe('mod');
    await expect(lite.loadSong(new Uint8Array(64))).rejects.toThrow('The lite replayer plays XM and MOD only');
    const r = await lite.createReplayer(xm(), { context: ctx as unknown as AudioContext });
    await r.play();
    expect(peak(advance(1).left)).toBeGreaterThan(0.01);
  });
});
