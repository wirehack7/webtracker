/**
 * Songs the user keeps in this browser, by name, saved as XM bytes like the
 * autosave. IndexedDB rather than localStorage, since a module with samples
 * easily passes the few megabytes localStorage allows.
 */

import { createDemoSong, DEMO_SONG_TITLE } from '@webtracker/engine';
import { saveXm } from '@webtracker/formats';
import type { AutosaveOrigin } from './autosave.ts';
import { done, LIBRARY_STORE as STORE, openDb, result } from './db.ts';

export interface LibrarySong {
  id: number;
  name: string;
  savedAt: number;
  bytes: Uint8Array;
  origin?: AutosaveOrigin;
  /** Set on the demo song while it is the copy the tracker put there. */
  demo?: number;
}

/** The demo version this browser has been given; a deleted demo stays deleted. */
const DEMO_KEY = 'webtracker.demoSong';
/** Raise when the demo song changes, to replace older copies nobody has edited. */
const DEMO_VERSION = 2;
export const DEMO_SONG_NAME = `Demo: ${DEMO_SONG_TITLE}`;

let seeding: Promise<void> | null = null;

/**
 * Adds the demo song the first time the library is opened in this browser,
 * and swaps an older demo for the current one. Copies the user saved over
 * lose the `demo` mark (saving writes a new record), so their edits are kept.
 */
function seedDemoSong(db: IDBDatabase): Promise<void> {
  seeding ??= (async () => {
    let seeded: number;
    try {
      seeded = Number(localStorage.getItem(DEMO_KEY) ?? 0);
    } catch {
      return;
    }
    if (seeded >= DEMO_VERSION) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const all = (await result(store.getAll())) as LibrarySong[];
    const bytes = saveXm(createDemoSong());
    if (!seeded) {
      if (!all.some((song) => song.name === DEMO_SONG_NAME)) store.put({ name: DEMO_SONG_NAME, savedAt: Date.now(), bytes, demo: DEMO_VERSION });
    } else {
      // Version 1 did not mark its copy, so it is found by name.
      const old = all.find((song) => (seeded === 1 ? song.name === DEMO_SONG_NAME : song.demo !== undefined));
      if (old) store.put({ ...old, bytes, demo: DEMO_VERSION });
    }
    await done(tx);
    try {
      localStorage.setItem(DEMO_KEY, String(DEMO_VERSION));
    } catch {
      // Without localStorage the name check above still keeps it from being added twice.
    }
  })().catch(() => {
    seeding = null;
  });
  return seeding;
}

/** All songs, last saved first. */
export async function listSongs(): Promise<LibrarySong[]> {
  const db = await openDb();
  await seedDemoSong(db);
  const all = (await result(db.transaction(STORE).objectStore(STORE).getAll())) as LibrarySong[];
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

/** Saves a song; with an `id` it replaces that song, without it adds a new one. Returns the id. */
export async function putSong(song: Omit<LibrarySong, 'id'> & { id?: number | undefined }): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const { id, ...rest } = song;
  const key = await result(tx.objectStore(STORE).put(id === undefined ? rest : { id, ...rest }));
  await done(tx);
  return key as number;
}

export async function renameSong(id: number, name: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const song = (await result(store.get(id))) as LibrarySong | undefined;
  if (song) store.put({ ...song, name });
  await done(tx);
}

export async function deleteSong(id: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await done(tx);
}
