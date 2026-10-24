import type { Song } from '@webtracker/engine';
import { isMod, loadMod } from './mod.ts';
import { isXm, loadXm } from './xm.ts';

export { loadMod } from './mod.ts';
export { loadXm } from './xm.ts';

/** Detects the format from the file contents (falling back to the file name) and parses it. */
export function loadModule(buffer: ArrayBuffer, fileName = ''): Song {
  const bytes = new Uint8Array(buffer);
  if (isXm(bytes)) return loadXm(buffer);
  if (isMod(bytes)) return loadMod(buffer);
  // Tagless 15-sample Soundtracker modules can only be recognised by name.
  if (/\.(mod|stk)$|^mod\./i.test(fileName)) return loadMod(buffer);
  throw new Error('Unknown module format (supported: MOD, XM)');
}
export { saveXm } from './xm-write.ts';
