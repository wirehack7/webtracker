/** The tracker's one IndexedDB database, shared by the autosave and the song library. */

import { msg } from '../i18n/i18n.ts';

const NAME = 'webtracker';
/** Version 1 had only the autosave store; version 2 adds the library. */
const VERSION = 2;
export const AUTOSAVE_STORE = 'autosave';
export const LIBRARY_STORE = 'songs';

export const BLOCKED = msg('Another chiptrackr tab or window with an older version is open. Close it (or reload it) and try again.');

let db: IDBDatabase | null = null;
let request: IDBOpenDBRequest | null = null;
/** An older version of the tracker in another tab holds the database open. */
let blocked = false;
let waiting: { resolve: (db: IDBDatabase) => void; reject: (error: Error) => void }[] = [];

function settle(result: IDBDatabase | Error): void {
  const all = waiting;
  waiting = [];
  for (const w of all) result instanceof Error ? w.reject(result) : w.resolve(result);
}

export function openDb(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  // The upgrade waits until the other tab closes; later calls get the database then.
  if (blocked) return Promise.reject(new Error(BLOCKED));
  const promise = new Promise<IDBDatabase>((resolve, reject) => waiting.push({ resolve, reject }));
  if (!request) {
    const opening = indexedDB.open(NAME, VERSION);
    request = opening;
    opening.onupgradeneeded = () => {
      const upgrading = opening.result;
      if (!upgrading.objectStoreNames.contains(AUTOSAVE_STORE)) upgrading.createObjectStore(AUTOSAVE_STORE, { keyPath: 'id' });
      if (!upgrading.objectStoreNames.contains(LIBRARY_STORE)) upgrading.createObjectStore(LIBRARY_STORE, { keyPath: 'id', autoIncrement: true });
    };
    opening.onsuccess = () => {
      const opened = opening.result;
      // Let a newer version of the tracker in another tab upgrade the database.
      opened.onversionchange = () => {
        opened.close();
        db = request = null;
      };
      db = opened;
      blocked = false;
      settle(opened);
    };
    opening.onblocked = () => {
      blocked = true;
      settle(new Error(BLOCKED));
    };
    opening.onerror = () => {
      request = null;
      blocked = false;
      settle(opening.error ?? new Error('IndexedDB is not available'));
    };
  }
  return promise;
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

export function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
  });
}
