/**
 * Keeps the last few versions of the song in IndexedDB, saved as XM bytes,
 * so a closed tab or a crash loses at most a few seconds of work.
 */

export interface Autosave {
  /** When this version was started, in ms since 1970; the key. */
  id: number;
  /** Last write to this version. */
  savedAt: number;
  title: string;
  bytes: Uint8Array;
}

const DB = 'webtracker';
const STORE = 'autosave';
/** Versions kept. A new version starts at most once a minute; within the minute the newest is updated. */
export const KEEP = 10;
const VERSION_GAP_MS = 60_000;

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error('IndexedDB is not available'));
    };
  });
  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

/** All kept versions, newest first. */
export async function listAutosaves(): Promise<Autosave[]> {
  const db = await open();
  const request = db.transaction(STORE).objectStore(STORE).getAll();
  const all = await new Promise<Autosave[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as Autosave[]);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
  });
  return all.sort((a, b) => b.id - a.id);
}

/** Saves the song; `fresh` starts a new version, for a song just created or loaded. */
export async function writeAutosave(title: string, bytes: Uint8Array, fresh = false, now = Date.now()): Promise<void> {
  const versions = await listAutosaves();
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const newest = versions[0];
  const id = !fresh && newest && now - newest.id < VERSION_GAP_MS ? newest.id : now;
  if (id === now) for (const old of versions.slice(KEEP - 1)) store.delete(old.id);
  store.put({ id, savedAt: now, title, bytes } satisfies Autosave);
  await done(tx);
}
