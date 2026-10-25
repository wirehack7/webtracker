/**
 * The webtracker replayer with every format the tracker loads: MOD, XM, S3M,
 * IT, MTM, 669 and OKT, also zipped or packed.
 */
import type { Song } from '@webtracker/engine';
import { loadModule } from '@webtracker/formats';
import { Replayer, toSong, type ReplayerOptions, type Source } from './replayer.ts';

export { Replayer, type ReplayerOptions, type Source, type MixerSettings, type Position, type Song } from './replayer.ts';

/** Loads a module and gets it ready to play; call `play()` on the result. */
export function createReplayer(source: Source, options?: ReplayerOptions): Promise<Replayer> {
  return Replayer.create(source, loadModule, options);
}

/** Loads a module without starting audio, for showing it before the first click; `createReplayer` takes the result. */
export function loadSong(source: Source, fileName?: string): Promise<Song> {
  return toSong(source, loadModule, fileName);
}
