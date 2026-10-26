import { createSong, writeCell, type Song } from '@webtracker/engine';
import { createZip, loadModule, saveMod, saveXm, unzipAll } from '@webtracker/formats';
import { describe, expect, it } from 'vitest';
import { originOf } from './autosave.ts';
import { createBackup, MANIFEST, planRestore, readBackup } from './backup.ts';
import type { LibrarySong } from './library.ts';

function song(title: string, channels = 8): Song {
  const s = createSong(channels);
  s.title = title;
  writeCell(s, s.patterns[0]!, 0, 0, { note: 49, instrument: 1 });
  return s;
}

function entry(id: number, name: string, s: Song, savedAt = 1000 + id): LibrarySong {
  return { id, name, savedAt, bytes: saveXm(s), origin: originOf(s) };
}

describe('library backup', () => {
  const mod = loadModule(saveMod(song('amiga', 4)).bytes.slice().buffer, 'amiga.mod');
  const library = [entry(1, 'Tune', song('tune')), entry(2, 'Tune', song('other')), entry(3, 'Amiga/Song?', mod), entry(4, 'tune', song('lower'))];

  it('stores each song once under a unique file name, MODs as MOD', () => {
    const files = unzipAll(createBackup(library)).map((f) => f.name);
    expect(files).toEqual(['Tune.xm', 'Tune (2).xm', 'Amiga_Song_.mod', 'tune (3).xm', MANIFEST]);
  });

  it('restores names, save times and the MOD origin', () => {
    const { songs, failed } = readBackup(createBackup(library));
    expect(failed).toEqual([]);
    expect(songs.map((s) => [s.name, s.savedAt, s.origin?.format])).toEqual([
      ['Tune', 1001, 'xm'],
      ['Tune', 1002, 'xm'],
      ['Amiga/Song?', 1003, 'mod'],
      ['tune', 1004, 'xm'],
    ]);
    expect(songs[0]!.bytes).toEqual(library[0]!.bytes);
    expect(loadModule(songs[2]!.bytes.slice().buffer, 'x.xm').channelPanning).toHaveLength(4);
  });

  it('reads a plain ZIP of modules without a manifest', () => {
    const zip = createZip([
      { name: 'music/cool.mod', data: saveMod(song('cool', 4)).bytes },
      { name: '__MACOSX/music/._cool.mod', data: new Uint8Array(10) },
      { name: 'readme.txt', data: new TextEncoder().encode('hi') },
      { name: 'broken.xm', data: new Uint8Array(100) },
    ]);
    const { songs, failed } = readBackup(zip, 42);
    expect(songs.map((s) => [s.name, s.savedAt, s.origin?.format])).toEqual([['cool', 42, 'mod']]);
    expect(failed).toEqual(['broken.xm']);
  });

  it('leaves out songs already in the library and renames clashes', () => {
    const { songs } = readBackup(createBackup(library));
    const existing = [library[0]!, { ...library[2]!, bytes: new Uint8Array(1) }, { ...library[3]!, savedAt: 1, bytes: new Uint8Array(1) }];
    const { add, skipped } = planRestore(existing, songs);
    expect(skipped).toBe(2);
    expect(add.map((s) => s.name)).toEqual(['Tune (2)', 'tune (2)']);
  });
});
