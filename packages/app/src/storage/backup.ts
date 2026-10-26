/**
 * Backs the whole song library up as one ZIP file and reads such a ZIP back.
 * Each song goes in as a module file the user can open anywhere: a MOD when
 * it came from a MOD and saves as one without losses, an XM otherwise. A small
 * JSON manifest keeps the library names, save times and MOD origins, so a
 * restore gives back the same library; without it any ZIP of modules works.
 */

import { createZip, loadModule, saveMod, saveXm, unzipAll, type ZipEntry } from '@webtracker/formats';
import { applyOrigin, originOf, type AutosaveOrigin } from './autosave.ts';
import type { LibrarySong } from './library.ts';

export const MANIFEST = 'chiptrackr-songs.json';

interface ManifestEntry {
  file: string;
  name: string;
  savedAt: number;
  origin?: AutosaveOrigin;
}

/** A song read from a backup, ready to add to the library. */
export type RestoredSong = Omit<LibrarySong, 'id' | 'demo'>;

const MODULE_FILE = /\.(mod|xm|s3m|it|mtm|669|okt|stk|mdz|xmz|s3z|itz|gz)$/i;

/** A file name that is safe on every system and not taken yet, compared without case. */
function uniqueFileName(name: string, ext: string, taken: Set<string>): string {
  const base = name.trim().replace(/[^\w .()-]+/g, '_').replace(/^[ .]+|[ .]+$/g, '') || 'untitled';
  for (let n = 1; ; n++) {
    const file = `${n === 1 ? base : `${base} (${n})`}.${ext}`;
    if (!taken.has(file.toLowerCase())) {
      taken.add(file.toLowerCase());
      return file;
    }
  }
}

/** The library as a ZIP archive. */
export function createBackup(songs: LibrarySong[]): Uint8Array {
  const taken = new Set([MANIFEST]);
  const files: ZipEntry[] = [];
  const manifest: ManifestEntry[] = [];
  for (const song of songs) {
    let data = song.bytes;
    let ext = 'xm';
    if (song.origin?.format === 'mod') {
      try {
        const mod = saveMod(applyOrigin(loadModule(song.bytes.slice().buffer, 'song.xm'), song.origin));
        if (mod.warnings.length === 0) [data, ext] = [mod.bytes, 'mod'];
      } catch {
        // Keep the XM; it opens in the tracker just the same.
      }
    }
    const file = uniqueFileName(song.name, ext, taken);
    files.push({ name: file, data });
    manifest.push({ file, name: song.name, savedAt: song.savedAt, ...(song.origin ? { origin: song.origin } : {}) });
  }
  const json = new TextEncoder().encode(JSON.stringify({ app: 'chiptrackr', version: 1, songs: manifest }, null, 1));
  return createZip([...files, { name: MANIFEST, data: json }]);
}

function readManifest(data: Uint8Array | undefined): Map<string, ManifestEntry> {
  const byFile = new Map<string, ManifestEntry>();
  if (!data) return byFile;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as { songs?: unknown };
    if (!Array.isArray(parsed.songs)) return byFile;
    for (const entry of parsed.songs as Partial<ManifestEntry>[]) {
      if (typeof entry?.file === 'string' && typeof entry.name === 'string') {
        byFile.set(entry.file, { file: entry.file, name: entry.name, savedAt: Number(entry.savedAt) || Date.now(), ...(entry.origin ? { origin: entry.origin } : {}) });
      }
    }
  } catch {
    // A broken manifest still leaves the modules themselves.
  }
  return byFile;
}

/**
 * The songs in a backup ZIP, stored the way the library keeps them (XM bytes
 * plus origin). `failed` names the module files that could not be read.
 */
export function readBackup(zip: Uint8Array, now = Date.now()): { songs: RestoredSong[]; failed: string[] } {
  const files = unzipAll(zip, 'backup.zip');
  const manifest = readManifest(files.find((f) => f.name === MANIFEST)?.data);
  const songs: RestoredSong[] = [];
  const failed: string[] = [];
  for (const { name: path, data } of files) {
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    // Skip folders' clutter such as macOS resource forks.
    if (path === MANIFEST || path.startsWith('__MACOSX/') || fileName.startsWith('._') || !MODULE_FILE.test(fileName)) continue;
    const meta = manifest.get(path);
    try {
      const song = applyOrigin(loadModule(data.slice().buffer, fileName), meta?.origin);
      // An XM goes back unchanged; anything else is stored as XM like a save.
      const bytes = /\.xm$/i.test(fileName) ? data : saveXm(song);
      songs.push({ name: meta?.name ?? fileName.replace(/\.[^.]+$/, ''), savedAt: meta?.savedAt ?? now, bytes, origin: originOf(song) });
    } catch {
      failed.push(fileName);
    }
  }
  return { songs, failed };
}

/**
 * What to add for a restore: songs already in the library with the same name
 * and the same save time or content are left out, and a different song under a taken name gets a
 * numbered name, so nothing in the library is overwritten.
 */
export function planRestore(existing: Pick<LibrarySong, 'name' | 'savedAt' | 'bytes'>[], restored: RestoredSong[]): { add: RestoredSong[]; skipped: number } {
  const names = new Set(existing.map((s) => s.name));
  const add: RestoredSong[] = [];
  let skipped = 0;
  const all = [...existing];
  for (const song of restored) {
    if (all.some((s) => s.name === song.name && (s.savedAt === song.savedAt || sameBytes(s.bytes, song.bytes)))) {
      skipped++;
      continue;
    }
    let name = song.name;
    for (let n = 2; names.has(name); n++) name = `${song.name} (${n})`;
    names.add(name);
    const entry = { ...song, name };
    add.push(entry);
    all.push(entry);
  }
  return { add, skipped };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
