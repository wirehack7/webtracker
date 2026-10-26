import { IDBFactory } from 'fake-indexeddb';
import { createDemoSong } from '@webtracker/engine';
import { loadModule } from '@webtracker/formats';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The IndexedDB layer (db.ts) and what sits on it, the song library and the
 * autosave, against fake-indexeddb, an implementation of the IndexedDB spec
 * in plain JavaScript. Each test gets an empty database and fresh modules.
 */

let indexedDB: IDBFactory;
let stored: Map<string, string>;

function fakeLocalStorage(throws = false) {
  return {
    getItem: (key: string) => {
      if (throws) throw new Error('blocked');
      return stored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (throws) throw new Error('blocked');
      stored.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  indexedDB = new IDBFactory();
  stored = new Map();
  vi.stubGlobal('indexedDB', indexedDB);
  vi.stubGlobal('localStorage', fakeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bytes = (...values: number[]) => new Uint8Array(values);

/** Opens the database at version 1 the way the first tracker release made it. */
function openVersion1(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('webtracker', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('autosave', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

describe('database', () => {
  it('creates both stores and hands every caller the same connection', async () => {
    const { openDb } = await import('./db.ts');
    const [a, b] = await Promise.all([openDb(), openDb()]);
    expect(a).toBe(b);
    expect(await openDb()).toBe(a);
    expect([...a.objectStoreNames].sort()).toEqual(['autosave', 'songs']);
  });

  it('upgrades a version 1 database and keeps its autosaves', async () => {
    const old = await openVersion1();
    await new Promise<void>((resolve) => {
      const tx = old.transaction('autosave', 'readwrite');
      tx.objectStore('autosave').put({ id: 1, savedAt: 1, title: 'kept', bytes: bytes(1) });
      tx.oncomplete = () => resolve();
    });
    old.close();
    const { listAutosaves } = await import('./autosave.ts');
    expect((await listAutosaves()).map((a) => a.title)).toEqual(['kept']);
  });

  it('says so when an older tab blocks the upgrade, and opens once that tab lets go', async () => {
    const old = await openVersion1();
    const { BLOCKED, openDb } = await import('./db.ts');
    const first = openDb();
    await expect(first).rejects.toThrow(BLOCKED);
    // Later calls fail straight away while the other tab holds on.
    await expect(openDb()).rejects.toThrow(BLOCKED);
    old.close();
    // The upgrade that was waiting goes through; the next call gets the database.
    await vi.waitFor(async () => expect(await openDb()).toBeTruthy());
  });

  it('closes its connection when a newer version wants to upgrade, and opens again after', async () => {
    const { openDb } = await import('./db.ts');
    const first = await openDb();
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('webtracker', 3);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    upgraded.close();
    // Version 3 is newer than the code asks for, so opening it fails; the error is passed on.
    await expect(openDb()).rejects.toThrow();
    expect(first).toBeTruthy();
  });

  it('rejects when IndexedDB cannot open, and tries again on the next call', async () => {
    const failing = {
      open: () => {
        const request = { error: null } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event('error')));
        return request;
      },
    };
    vi.stubGlobal('indexedDB', failing);
    const { openDb } = await import('./db.ts');
    await expect(openDb()).rejects.toThrow('IndexedDB is not available');
    vi.stubGlobal('indexedDB', indexedDB);
    expect(await openDb()).toBeTruthy();
  });

  it('turns failed requests and transactions into rejections', async () => {
    const { done, openDb, result } = await import('./db.ts');
    const db = await openDb();
    const tx = db.transaction('songs', 'readwrite');
    const finished = done(tx);
    tx.abort();
    await expect(finished).rejects.toThrow();
    const failed = { error: new Error('read failed') } as unknown as IDBRequest<number>;
    const read = result(failed);
    failed.onerror!(new Event('error'));
    await expect(read).rejects.toThrow('read failed');
    const failedTx = { error: null } as unknown as IDBTransaction;
    const write = done(failedTx);
    failedTx.onerror!(new Event('error'));
    await expect(write).rejects.toThrow('IndexedDB write failed');
  });
});

describe('song library', () => {
  it('puts the demo song in the first time, and only once', async () => {
    const { DEMO_SONG_NAME, listSongs } = await import('./library.ts');
    const songs = await listSongs();
    expect(songs.map((s) => s.name)).toEqual([DEMO_SONG_NAME]);
    expect(loadModule(songs[0]!.bytes.slice().buffer).title).toBe(createDemoSong().title);
    expect(stored.get('webtracker.demoSong')).toBe('2');
    expect(await listSongs()).toHaveLength(1);
  });

  it('leaves a deleted demo song deleted', async () => {
    const { deleteSong, listSongs } = await import('./library.ts');
    const [demo] = await listSongs();
    await deleteSong(demo!.id);
    vi.resetModules();
    const again = await import('./library.ts');
    expect(await again.listSongs()).toEqual([]);
  });

  it('replaces the demo of an older version, found by name for version 1', async () => {
    const { DEMO_SONG_NAME, putSong } = await import('./library.ts');
    stored.set('webtracker.demoSong', '9');
    await putSong({ name: DEMO_SONG_NAME, savedAt: 5, bytes: bytes(1, 2, 3) });
    vi.resetModules();
    stored.set('webtracker.demoSong', '1');
    const v1 = await import('./library.ts');
    const [song] = await v1.listSongs();
    expect(song).toMatchObject({ name: DEMO_SONG_NAME, savedAt: 5, demo: 2 });
    expect(song!.bytes.length).toBeGreaterThan(3);
  });

  it('replaces a marked demo of a later version, and keeps a copy the user saved', async () => {
    const lib = await import('./library.ts');
    stored.set('webtracker.demoSong', '9');
    const marked = await lib.putSong({ name: 'renamed demo', savedAt: 1, bytes: bytes(1), demo: 1 });
    const own = await lib.putSong({ name: lib.DEMO_SONG_NAME, savedAt: 2, bytes: bytes(2) });
    vi.resetModules();
    // Versions after 1 mark their copy. With the current version at 2 there is no
    // such older version yet, so a stored value between the two stands in for one.
    stored.set('webtracker.demoSong', '1.5');
    const next = await import('./library.ts');
    const songs = await next.listSongs();
    expect(songs.find((s) => s.id === marked)!.demo).toBe(2);
    expect(songs.find((s) => s.id === own)!.bytes).toEqual(bytes(2));
  });

  it('does not add the demo when local storage is blocked', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage(true));
    const { listSongs } = await import('./library.ts');
    expect(await listSongs()).toEqual([]);
  });

  it('saves, lists newest first, renames, replaces and deletes', async () => {
    stored.set('webtracker.demoSong', '2');
    const { deleteSong, listSongs, putSong, renameSong } = await import('./library.ts');
    const a = await putSong({ name: 'a', savedAt: 1, bytes: bytes(1) });
    const b = await putSong({ name: 'b', savedAt: 2, bytes: bytes(2), origin: { format: 'mod', formatName: 'M.K.', channelPanning: [0, 255, 255, 0] } });
    expect((await listSongs()).map((s) => s.name)).toEqual(['b', 'a']);
    await renameSong(a, 'first');
    await renameSong(999, 'nobody');
    await putSong({ id: b, name: 'b', savedAt: 0, bytes: bytes(3) });
    const songs = await listSongs();
    expect(songs.map((s) => s.name)).toEqual(['first', 'b']);
    expect(songs[1]!.bytes).toEqual(bytes(3));
    await deleteSong(a);
    expect((await listSongs()).map((s) => s.id)).toEqual([b]);
  });

  it('adds several songs at once', async () => {
    stored.set('webtracker.demoSong', '2');
    const { addSongs, listSongs } = await import('./library.ts');
    await addSongs([
      { name: 'x', savedAt: 1, bytes: bytes(1) },
      { name: 'y', savedAt: 2, bytes: bytes(2) },
    ]);
    expect((await listSongs()).map((s) => s.name)).toEqual(['y', 'x']);
  });
});

describe('autosave', () => {
  it('updates the newest version within a minute and starts a new one after', async () => {
    const { listAutosaves, writeAutosave } = await import('./autosave.ts');
    await writeAutosave('one', bytes(1), false, 1_000);
    await writeAutosave('one again', bytes(2), false, 30_000);
    expect((await listAutosaves()).map((a) => [a.id, a.title, a.savedAt])).toEqual([[1_000, 'one again', 30_000]]);
    await writeAutosave('two', bytes(3), false, 70_000);
    expect((await listAutosaves()).map((a) => a.title)).toEqual(['two', 'one again']);
  });

  it('starts a new version for a fresh song at once', async () => {
    const { listAutosaves, writeAutosave } = await import('./autosave.ts');
    await writeAutosave('old', bytes(1), false, 1_000);
    await writeAutosave('new', bytes(2), true, 2_000);
    expect((await listAutosaves()).map((a) => a.title)).toEqual(['new', 'old']);
  });

  it(`keeps the last versions only, with the origin of a MOD`, async () => {
    const { KEEP, listAutosaves, writeAutosave } = await import('./autosave.ts');
    const origin = { format: 'mod' as const, formatName: 'M.K.', channelPanning: [0, 255, 255, 0] };
    for (let i = 0; i < KEEP + 3; i++) await writeAutosave(`v${i}`, bytes(i), true, i * 100_000, origin);
    const all = await listAutosaves();
    expect(all).toHaveLength(KEEP);
    expect(all[0]).toMatchObject({ title: `v${KEEP + 2}`, origin });
    expect(all.at(-1)!.title).toBe('v3');
  });

  it('copies the origin of a song', async () => {
    const { originOf } = await import('./autosave.ts');
    const song = { format: 'mod' as const, formatName: 'M.K.', channelPanning: [1, 2], title: 'x' };
    const origin = originOf(song);
    expect(origin).toEqual({ format: 'mod', formatName: 'M.K.', channelPanning: [1, 2] });
    expect(origin.channelPanning).not.toBe(song.channelPanning);
  });
});
