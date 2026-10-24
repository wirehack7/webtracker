import type { Song } from '@webtracker/engine';
import { isMod, loadMod } from './mod.ts';
import { isXm, loadXm } from './xm.ts';
import { isS3m, loadS3m } from './s3m.ts';
import { isIt, loadIt } from './it.ts';

export { loadMod } from './mod.ts';
export { loadXm } from './xm.ts';
export { loadS3m } from './s3m.ts';
export { loadIt } from './it.ts';

/** Detects the format from the file contents (falling back to the file name) and parses it. */
export function loadModule(buffer: ArrayBuffer, fileName = ''): Song {
  const bytes = new Uint8Array(buffer);
  if (isXm(bytes)) return loadXm(buffer);
  if (isS3m(bytes)) return loadS3m(buffer);
  if (isIt(bytes)) return loadIt(buffer);
  if (isMod(bytes)) return loadMod(buffer);
  // Tagless 15-sample Soundtracker modules can only be recognised by name.
  if (/\.(mod|stk)$|^mod\./i.test(fileName)) return loadMod(buffer);
  throw new Error('Unknown module format (supported: MOD, XM, S3M, IT)');
}
export { saveXm } from './xm-write.ts';
export { saveXi } from './xm-write.ts';
export { importSample, sampleFromChannels, type Imported } from './sample-import.ts';
export { saveMod, type SavedMod } from './mod-write.ts';
export { encodeWav, type WavFormat } from './wav-write.ts';
export { createZip, crc32, type ZipEntry } from './zip.ts';
