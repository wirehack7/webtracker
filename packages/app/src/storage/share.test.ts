import { createSong, LoopType, type Song } from '@webtracker/engine';
import { loadModule, saveXm } from '@webtracker/formats';
import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, pipe, fromBase64Url, replayerUrl, shareFromHash, shrinkSong } from './share.ts';

/** A song with one long 16-bit sample, looped halfway. */
function songWithSample(): Song {
  const s = createSong(4);
  const data = Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i / 7) * 0.6 + Math.sin(i / 3.1) * 0.2);
  s.instruments[0]!.samples[0] = {
    ...s.instruments[0]!.samples[0]!,
    data,
    loopStart: 2000,
    loopLength: 2000,
    loopType: LoopType.Forward,
  };
  return s;
}

describe('share links', () => {
  it('bring back the same XM bytes', async () => {
    const xm = saveXm(songWithSample());
    const link = await encodeShare(xm);
    expect(link).toMatch(/^[\w-]+$/);
    const back = await decodeShare(link);
    expect(Array.from(back.xm)).toEqual(Array.from(xm));
    expect(back.origin).toBeUndefined();
  });

  it('keep what XM loses for a MOD', async () => {
    const origin = { format: 'mod' as const, formatName: 'M.K.', channelPanning: [0, 255, 255, 0] };
    const back = await decodeShare(await encodeShare(saveXm(createSong(4)), origin));
    expect(back.origin).toEqual(origin);
  });

  it('get shorter with lower quality and still load', async () => {
    const song = songWithSample();
    const sizes = [];
    for (const quality of ['lossless', 'small', 'smallest'] as const) {
      const shrunk = shrinkSong(song, quality);
      const link = await encodeShare(saveXm(shrunk));
      sizes.push(link.length);
      const loaded = loadModule((await decodeShare(link)).xm.slice().buffer, 'shared.xm');
      expect(loaded.instruments[0]!.samples[0]!.loopLength).toBe(quality === 'smallest' ? 1000 : 2000);
    }
    expect(sizes[1]).toBeLessThan(sizes[0]! / 2);
    expect(sizes[2]).toBeLessThan(sizes[1]!);
    // The original song is untouched.
    expect(song.instruments[0]!.samples[0]!.data.length).toBe(8000);
  });

  it('keep the pitch when halving the rate', () => {
    const s = shrinkSong(songWithSample(), 'smallest').instruments[0]!.samples[0]!;
    expect(s.data.length).toBe(2000);
    expect(s.relativeNote).toBe(-12);
  });

  it('report a damaged link', async () => {
    await expect(decodeShare('not-a-song')).rejects.toThrow(/damaged/);
  });

  it('are found in the fragment', () => {
    expect(shareFromHash('#song=abc_-')).toBe('abc_-');
    expect(shareFromHash('#other=1')).toBeNull();
    expect(shareFromHash('')).toBeNull();
  });
});

describe('replayer hand-over', () => {
  it('puts the module and its name into the replayer address', async () => {
    const xm = saveXm(songWithSample());
    const url = new URL(await replayerUrl('https://chiptrackr.com/?x=1#song=abc', xm, 'my song.xm'));
    expect(url.origin + url.pathname).toBe('https://chiptrackr.com/replayer/');
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get('name')).toBe('my song.xm');
    const back = await pipe(fromBase64Url(params.get('module')!), new DecompressionStream('deflate-raw'));
    expect(Array.from(back)).toEqual(Array.from(xm));
  });
});
