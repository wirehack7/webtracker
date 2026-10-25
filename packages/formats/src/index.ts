import type { Song } from '@webtracker/engine';
import { isMod, loadMod } from './mod.ts';
import { isXm, loadXm } from './xm.ts';
import { isS3m, loadS3m } from './s3m.ts';
import { isIt, loadIt } from './it.ts';
import { isMtm, loadMtm } from './mtm.ts';
import { isOkt, loadOkt } from './okt.ts';
import { is669, load669 } from './669.ts';
import { unpackModule } from './unpack.ts';

export { loadMod } from './mod.ts';
export { loadXm } from './xm.ts';
export { loadS3m } from './s3m.ts';
export { loadIt } from './it.ts';
export { loadMtm } from './mtm.ts';
export { loadOkt } from './okt.ts';
export { load669 } from './669.ts';

/**
 * Detects the format from the file contents (falling back to the file name)
 * and parses it. Packed modules (ZIP, gzip, MMCMP, PowerPacker) are unpacked first.
 */
export function loadModule(buffer: ArrayBuffer, fileName = ''): Song {
  const unpacked = unpackModule(new Uint8Array(buffer), fileName);
  if (unpacked.containers.length === 0) return detect(buffer, fileName);
  const song = detect(unpacked.bytes.slice().buffer, unpacked.fileName);
  song.formatName += ` (${unpacked.containers.join(', ')})`;
  return song;
}

function detect(buffer: ArrayBuffer, fileName: string): Song {
  const bytes = new Uint8Array(buffer);
  if (isXm(bytes)) return loadXm(buffer);
  if (isS3m(bytes)) return loadS3m(buffer);
  if (isIt(bytes)) return loadIt(buffer);
  if (isMtm(bytes)) return loadMtm(buffer);
  if (isOkt(bytes)) return loadOkt(buffer);
  if (isMod(bytes)) return loadMod(buffer);
  // 669 has only a two-letter tag, so it is tried after the formats with stronger ones.
  if (is669(bytes)) return load669(buffer);
  // Tagless 15-sample Soundtracker modules can only be recognised by name.
  if (/\.(mod|stk)$|^mod\./i.test(fileName)) return loadMod(buffer);
  throw new Error('Unknown module format (supported: MOD, XM, S3M, IT, MTM, 669, OKT)');
}

export { saveXm } from './xm-write.ts';
export { saveXi } from './xm-write.ts';
export { importSample, sampleFromChannels, type Imported } from './sample-import.ts';
export { saveMod, type SavedMod } from './mod-write.ts';
export { encodeWav, type WavFormat } from './wav-write.ts';
export { createZip, crc32, type ZipEntry } from './zip.ts';
export { unpackModule, type Unpacked } from './unpack.ts';
export { inflateRaw } from './inflate.ts';
export { applyTrack, loadXp, loadXt, saveXp, saveXt, type LoadedXp } from './xp.ts';
