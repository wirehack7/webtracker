/** The smallest webtracker replayer: XM and MOD only, for size-limited intros. */
import { isMod, loadMod } from '@webtracker/formats/mod.ts';
import { isXm, loadXm } from '@webtracker/formats/xm.ts';
import type { Song } from '@webtracker/engine';
import { Replayer, type ReplayerOptions, type Source } from './replayer.ts';

export { Replayer, type ReplayerOptions, type Source, type MixerSettings, type Position, type Song } from './replayer.ts';

function parse(buffer: ArrayBuffer): Song {
  const bytes = new Uint8Array(buffer);
  if (isXm(bytes)) return loadXm(buffer);
  if (isMod(bytes)) return loadMod(buffer);
  throw new Error('The lite replayer plays XM and MOD only');
}

/** Loads an XM or MOD and gets it ready to play; call `play()` on the result. */
export function createReplayer(source: Source, options?: ReplayerOptions): Promise<Replayer> {
  return Replayer.create(source, parse, options);
}
