import { createSong, Player, writeCell, type Song } from '@webtracker/engine';
import { loadModule, saveMod, saveXm } from '@webtracker/formats';
import { describe, expect, it } from 'vitest';
import { applyOrigin } from './autosave.ts';

function render(song: Song): Float32Array[] {
  const player = new Player(song, 44100);
  player.playing = true;
  const left = new Float32Array(44100);
  const right = new Float32Array(44100);
  player.process(left, right);
  return [left, right];
}

/** A MOD that uses effects whose memory differs between MOD and XM. */
function modSong(): Song {
  const s = createSong(4);
  const p = s.patterns[0]!;
  writeCell(s, p, 0, 0, { note: 37, instrument: 1 });
  writeCell(s, p, 1, 0, { effect: 0x1, param: 0x04 });
  writeCell(s, p, 2, 0, { effect: 0x1, param: 0x00 });
  writeCell(s, p, 3, 0, { effect: 0xa, param: 0x02 });
  writeCell(s, p, 4, 0, { effect: 0xa, param: 0x00 });
  writeCell(s, p, 0, 1, { note: 49, instrument: 2 });
  return loadModule(saveMod(s).bytes.slice().buffer, 'test.mod');
}

describe('autosave of a MOD', () => {
  it('plays the same after restoring from the XM autosave', () => {
    const mod = modSong();
    expect(mod.format).toBe('mod');
    const restored = applyOrigin(loadModule(saveXm(mod).slice().buffer, 'autosave.xm'), {
      format: mod.format,
      formatName: mod.formatName,
      channelPanning: mod.channelPanning,
    });
    expect(restored.format).toBe('mod');
    expect(restored.channelPanning).toEqual(mod.channelPanning);
    const [a, b] = [render(mod), render(restored)];
    expect(Array.from(b[0]!)).toEqual(Array.from(a[0]!));
    expect(Array.from(b[1]!)).toEqual(Array.from(a[1]!));
  });

  it('leaves versions saved without an origin as XM', () => {
    const xm = loadModule(saveXm(modSong()).slice().buffer, 'autosave.xm');
    expect(applyOrigin(xm, undefined).format).toBe('xm');
  });
});
