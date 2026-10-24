/**
 * Songs the user keeps in this browser, by name, saved as XM bytes like the
 * autosave. IndexedDB rather than localStorage, since a module with samples
 * easily passes the few megabytes localStorage allows.
 */

import type { AutosaveOrigin } from './autosave.ts';
import { done, LIBRARY_STORE as STORE, openDb, result } from './db.ts';

export interface LibrarySong {
  id: number;
  name: string;
  savedAt: number;
  bytes: Uint8Array;
  origin?: AutosaveOrigin;
}

/** All songs, last saved first. */
export async function listSongs(): Promise<LibrarySong[]> {
  const db = await openDb();
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
