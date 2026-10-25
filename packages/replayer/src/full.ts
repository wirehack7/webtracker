/**
 * The webtracker replayer with every format the tracker loads: MOD, XM, S3M,
 * IT, MTM, 669 and OKT, also zipped or packed.
 */
import { loadModule } from '@webtracker/formats';
import { Replayer, type ReplayerOptions, type Source } from './replayer.ts';

export { Replayer, type ReplayerOptions, type Source, type MixerSettings, type Position, type Song } from './replayer.ts';

/** Loads a module and gets it ready to play; call `play()` on the result. */
export function createReplayer(source: Source, options?: ReplayerOptions): Promise<Replayer> {
  return Replayer.create(source, loadModule, options);
}
