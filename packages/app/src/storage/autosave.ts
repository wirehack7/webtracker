/**
 * Keeps the last few versions of the song in IndexedDB, saved as XM bytes,
 * so a closed tab or a crash loses at most a few seconds of work.
 */

import { AUTOSAVE_STORE as STORE, done, openDb, result } from './db.ts';

export interface Autosave {
  /** When this version was started, in ms since 1970; the key. */
  id: number;
  /** Last write to this version. */
  savedAt: number;
  title: string;
  bytes: Uint8Array;
  /**
   * What XM cannot hold for a MOD: its format, which selects the ProTracker
   * effect rules in the player, and the hard Amiga channel panning.
   * Missing on versions saved before this was added.
   */
  origin?: AutosaveOrigin;
}

export interface AutosaveOrigin {
  format: 'mod' | 'xm';
  formatName: string;
  channelPanning: number[];
}

/** Versions kept. A new version starts at most once a minute; within the minute the newest is updated. */
export const KEEP = 10;
const VERSION_GAP_MS = 60_000;

/** All kept versions, newest first. */
export async function listAutosaves(): Promise<Autosave[]> {
  const db = await openDb();
  const all = (await result(db.transaction(STORE).objectStore(STORE).getAll())) as Autosave[];
  return all.sort((a, b) => b.id - a.id);
}

/** Saves the song; `fresh` starts a new version, for a song just created or loaded. */
export async function writeAutosave(
  title: string,
  bytes: Uint8Array,
  fresh = false,
  now = Date.now(),
  origin?: AutosaveOrigin,
): Promise<void> {
  const versions = await listAutosaves();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const newest = versions[0];
  const id = !fresh && newest && now - newest.id < VERSION_GAP_MS ? newest.id : now;
  if (id === now) for (const old of versions.slice(KEEP - 1)) store.delete(old.id);
  store.put({ id, savedAt: now, title, bytes, ...(origin ? { origin } : {}) } satisfies Autosave);
  await done(tx);
}

/** What saving as XM would lose of a MOD, kept beside the XM bytes. */
export function originOf(song: AutosaveOrigin): AutosaveOrigin {
  return { format: song.format, formatName: song.formatName, channelPanning: [...song.channelPanning] };
}

/** Undoes what saving as XM changed for a song that was loaded from a MOD. */
export function applyOrigin<T extends AutosaveOrigin>(song: T, origin: AutosaveOrigin | undefined): T {
  if (origin?.format === 'mod' && origin.channelPanning.length === song.channelPanning.length) {
    song.format = 'mod';
    song.formatName = origin.formatName;
    song.channelPanning = [...origin.channelPanning];
  }
  return song;
}
