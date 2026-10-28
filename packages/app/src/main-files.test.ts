// @vitest-environment happy-dom
import { createDemoSong, createSong, writeCell, type Song } from '@webtracker/engine';
import { createZip, encodeWav, loadModule, saveMod, saveXi, saveXm, saveXp, saveXt } from '@webtracker/formats';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootApp, FakeWorker, shutdownApp, type App } from './test-app.ts';
import { encodeShare } from './storage/share.ts';
import { DEMO_SONG_NAME } from './storage/library.ts';

/**
 * Files on the tracker page: opening modules, samples and pattern files,
 * saving and exporting, autosaved versions, the song library, share links
 * and song tabs.
 */

let app: App;

afterEach(() => shutdownApp());

const file = (bytes: Uint8Array | string, name: string) => new File([bytes as BlobPart], name);
function titled(title: string, channels = 4): Song {
  const song = createSong(channels);
  song.title = title;
  writeCell(song, song.patterns[0]!, 0, 0, { note: 49, instrument: 1 });
  return song;
}
const xmFile = (title: string) => file(saveXm(titled(title)), `${title}.xm`);

describe('opening files', () => {
  it('opens a module and says what it is', async () => {
    app = await bootApp();
    await app.pick('#file', xmFile('First'));
    expect(app.status()).toBe('First.xm: First, XM 1.04 (webtracker), 4 channels.');
    expect(app.$<HTMLInputElement>('#title').value).toBe('First');
    expect(app.cell(0, 0)).toContain('C-4');
    const mod = saveMod(titled('Amiga')).bytes;
    await app.pick('#file', file(mod, 'amiga.mod'));
    expect(app.status()).toMatch(/^amiga\.mod: Amiga, /);
    expect(app.song().title).toBe('Amiga');
  });

  it('explains in a dialog why a file did not open', async () => {
    app = await bootApp();
    await app.pick('#file', file('not a module', 'notes.txt'));
    expect(app.status()).toMatch(/^Could not load notes\.txt: /);
    expect(app.dialog()!.textContent).toContain('notes.txt could not be opened');
    await app.answer('OK');
    // An empty pick does nothing.
    await app.pick('#file', undefined as unknown as File);
  });

  it('asks before replacing changes when song tabs are off', async () => {
    app = await bootApp({ storage: { 'webtracker.settings': JSON.stringify({ songTabs: false }) } });
    app.key('Space');
    app.key('KeyQ');
    await app.pick('#file', xmFile('Next'));
    expect(app.dialog()!.textContent).toContain('Discard the changes to the current song?');
    await app.answer('Cancel');
    expect(app.$<HTMLInputElement>('#title').value).toBe('');
    await app.pick('#file', xmFile('Next'));
    await app.answer('Discard');
    expect(app.$<HTMLInputElement>('#title').value).toBe('Next');
  });

  it('puts samples and instruments into the current slot', async () => {
    app = await bootApp();
    const wav = encodeWav([Float32Array.from({ length: 100 }, (_, i) => Math.sin(i))], 22050, 'pcm16');
    await app.pick('#file', file(wav, 'tone.wav'));
    expect(app.status()).toBe('tone.wav: 100 frames at 22050 Hz in 01/0.');
    expect(app.$('#app').dataset.view).toBe('sample');
    app.click('#sample-list li[data-index="2"]');
    await app.pick('#sample-file', file(new Uint8Array(64).fill(10), 'blip.raw'));
    expect(app.status()).toBe('blip.raw: 64 frames at 8363 Hz in 01/2, read as raw 8-bit signed (Setup changes the format).');
    const xi = saveXi(createDemoSong().instruments[1]!);
    await app.pick('#sample-file', file(xi, 'lead.xi'));
    expect(app.status()).toMatch(/^lead\.xi: instrument with \d+ samples in 01\.$/);
  });

  it('decodes other audio in the browser, and takes what it cannot decode as raw', async () => {
    app = await bootApp();
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        async decodeAudioData(buffer: ArrayBuffer) {
          if (new Uint8Array(buffer)[0] === 0xff) throw new Error('not audio');
          return { numberOfChannels: 2, getChannelData: () => new Float32Array(441) };
        }
      },
    );
    await app.pick('#sample-file', file(new Uint8Array([1, 2, 3]), 'song.mp3'));
    expect(app.status()).toBe('song.mp3: 441 frames at 44100 Hz in 01/0.');
    await app.pick('#sample-file', file(new Uint8Array([0xff, 2, 3]), 'odd.ogg'));
    expect(app.status()).toMatch(/^odd\.ogg: 3 frames at 8363 Hz in 01\/0, read as raw/);
  });

  it('loads pattern and track files into the current pattern', async () => {
    app = await bootApp();
    const source = titled('src', 8);
    writeCell(source, source.patterns[0]!, 1, 5, { note: 50, instrument: 1 });
    writeCell(source, source.patterns[0]!, 2, 7, { note: 51, instrument: 1 });
    await app.pick('#file', file(saveXp(source, source.patterns[0]!), 'beat.xp'));
    expect(app.status()).toBe('Loaded beat.xp, 64 rows; 2 channels past 4 were left out.');
    expect(app.cell(0, 0)).toContain('C-4');
    const four = titled('four');
    await app.pick('#file', file(saveXp(four, four.patterns[0]!), 'four.xp'));
    expect(app.status()).toBe('Loaded four.xp, 64 rows.');
    app.key('Tab');
    await app.pick('#file', file(saveXt(four, four.patterns[0]!, 0), 'lead.xt'));
    expect(app.status()).toBe('Loaded lead.xt into channel 2.');
    expect(app.cell(0, 1)).toContain('C-4');
    await app.pick('#file', file(new Uint8Array(3), 'broken.xt'));
    expect(app.status()).toMatch(/^Could not load broken\.xt/);
    await app.answer('OK');
  });

  it('opens what is dropped on the page', async () => {
    app = await bootApp();
    const drop = (f: File | null) => {
      const event = new Event('drop', { cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { files: f ? [f] : [] } });
      window.dispatchEvent(event);
    };
    const over = new Event('dragover', { cancelable: true });
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    drop(xmFile('Dropped'));
    await app.settle(10);
    expect(app.$<HTMLInputElement>('#title').value).toBe('Dropped');
    const four = titled('four');
    drop(file(saveXp(four, four.patterns[0]!), 'p.xp'));
    await app.settle(10);
    expect(app.status()).toBe('Loaded p.xp, 64 rows.');
    drop(file(encodeWav([new Float32Array(10)], 8000, 'pcm16'), 'hit.wav'));
    await app.settle(10);
    expect(app.status()).toBe('hit.wav: 10 frames at 8000 Hz in 01/0.');
    drop(null);
  });

  it('opens the file picker from Load and Ctrl+O', async () => {
    app = await bootApp();
    const click = vi.spyOn(app.$<HTMLInputElement>('#file'), 'click').mockImplementation(() => {});
    app.click('#load');
    app.key('KeyO', { ctrlKey: true });
    expect(click).toHaveBeenCalledTimes(2);
  });
});

const loud = titled('loud');
writeCell(loud, loud.patterns[0]!, 1, 0, { note: 49, instrument: 1, effect: 0x10, param: 0x20 });

describe('saving', () => {
  it('saves XM, MOD, pattern and track files', async () => {
    app = await bootApp();
    app.click('#save');
    expect(app.dialog()!.id).toBe('file-dialog');
    app.click('#save-xm');
    expect(app.downloads.at(-1)).toMatchObject({ name: 'untitled.xm', type: 'application/octet-stream' });
    expect(app.status()).toMatch(/^Saved untitled\.xm \(\d+ bytes\)\.$/);
    app.click('#save-mod');
    expect(app.downloads.at(-1)!.name).toBe('untitled.mod');
    expect(app.$('#save-info').textContent).toBe('Saved as MOD with nothing lost.');
    // Effects past F are XM's own, and MOD has no place for them.
    await app.pick('#file', file(saveXm(loud), 'loud.xm'));
    app.click('#save-mod');
    expect(app.$('#save-info').textContent).toMatch(/^MOD can't hold everything: /);
    app.click('#save-xp');
    expect(app.downloads.at(-1)!.name).toBe('loud-00.xp');
    app.click('#save-xt');
    expect(app.downloads.at(-1)!.name).toBe('loud-00-ch1.xt');
    expect(app.$('#save-info').textContent).toBe('Saved channel 1 of pattern 00 as loud-00-ch1.xt.');
    app.dialog()!.close();
    app.key('KeyS', { ctrlKey: true });
    expect(app.downloads.at(-1)!.name).toBe('loud.xm');
  });

  it('saves a MOD with nothing lost', async () => {
    app = await bootApp();
    await app.pick('#file', file(saveMod(titled('Clean')).bytes, 'clean.mod'));
    app.click('#save-mod');
    expect(app.$('#save-info').textContent).toBe('Saved as MOD with nothing lost.');
  });

  it('saves the sample as WAV or 8SVX and the instrument as XI', async () => {
    app = await bootApp();
    app.click('[data-view-target="sample"]');
    const button = (label: string) => [...app.$('#editors').querySelectorAll('button')].find((b) => b.textContent === label)!;
    button('Save').click();
    expect(app.downloads.at(-1)).toMatchObject({ name: 'Square 50_.wav', type: 'audio/wav' });
    button('IFF').click();
    expect(app.downloads.at(-1)!.name).toBe('Square 50_.8svx');
    expect(app.status()).toMatch(/^Saved Square 50_\.8svx \(8-bit\) at \d+ Hz\.$/);
    button('Save XI').click();
    expect(app.downloads.at(-1)!.name).toBe('Square 50_.xi');
    app.click('#sample-list li[data-index="5"]');
    button('Save').click();
    expect(app.status()).toBe('This sample slot is empty.');
  });

  it('opens the song in the replayer page, or says why it cannot', async () => {
    app = await bootApp();
    app.click('#save');
    // Packing the song is compressed off the main thread, which takes a moment.
    const info = (text: string | RegExp) => vi.waitFor(() => expect(app.$('#replayer-info').textContent).toMatch(text));
    app.click('#open-replayer');
    await info('untitled.xm opened in the replayer.');
    expect(app.opened[0]!.tab!.location.href).toMatch(/replayer.*#/);
    await app.pick('#file', file(saveMod(titled('Amiga')).bytes, 'a.mod'));
    app.click('#open-replayer');
    await info('Amiga.mod opened in the replayer.');
    vi.stubGlobal('open', () => null);
    app.click('#open-replayer');
    await info(/^The browser blocked the new tab/);
  });
});

describe('audio and video export', () => {
  it('renders audio in a worker, shows progress and downloads the file', async () => {
    app = await bootApp();
    app.click('#save');
    FakeWorker.script = [[{ type: 'progress', fraction: 0.5 }, { type: 'done', bytes: new Uint8Array(10), fileName: 'untitled.wav', seconds: 65 }]];
    app.click('#export-go');
    expect(app.$('#export-go').textContent).toBe('Cancel');
    expect(app.$('#export-info').textContent).toBe('Rendering…');
    await app.settle();
    expect(app.downloads.at(-1)).toMatchObject({ name: 'untitled.wav', type: 'audio/wav' });
    expect(app.$('#export-info').textContent).toMatch(/^untitled\.wav: 1:05 of audio, 0\.0 MB, rendered in [\d.]+ s\.$/);
    expect(app.$<HTMLProgressElement>('#export-progress').hidden).toBe(true);
    expect(FakeWorker.all[0]!.requests[0]).toMatchObject({ stems: false, sampleRate: 44100, format: { kind: 'wav', format: 'pcm16' } });
  });

  it('reports failures, and cancels on a second click', async () => {
    app = await bootApp();
    FakeWorker.script = [[{ type: 'error', message: 'too long' }], ['crash'], []];
    app.click('#export-go');
    await app.settle();
    expect(app.$('#export-info').textContent).toBe('Export failed: too long');
    app.click('#export-go');
    await app.settle();
    expect(app.status()).toBe('Export failed: worker crashed');
    app.click('#export-go');
    app.click('#export-go');
    expect(app.status()).toBe('Export cancelled.');
    expect(FakeWorker.all[2]!.terminated).toBe(true);
    // Stems come as a ZIP.
    app.$<HTMLSelectElement>('#export-what').value = 'stems';
    FakeWorker.script = [[{ type: 'done', bytes: createZip([]), fileName: 'untitled stems.zip', seconds: 1 }]];
    app.click('#export-go');
    await app.settle();
    expect(app.downloads.at(-1)!.type).toBe('application/zip');
  });

  it('renders video, records it where the browser cannot encode, and cancels', async () => {
    // Whether the page can make videos is decided as it starts.
    app = await bootApp({ before: () => ['VideoEncoder', 'AudioEncoder', 'OffscreenCanvas'].forEach((name) => vi.stubGlobal(name, class {})) });
    expect(app.$<HTMLButtonElement>('#video-go').disabled).toBe(false);
    FakeWorker.script = [[{ type: 'progress', fraction: 0.5 }, { type: 'done', bytes: new Uint8Array(5), fileName: 'untitled.webm', seconds: 3, codecs: 'VP9 + OPUS' }]];
    app.click('#video-go');
    expect(app.$('#video-go').textContent).toBe('Cancel');
    await app.settle(10);
    expect(app.downloads.at(-1)).toMatchObject({ name: 'untitled.webm', type: 'video/webm' });
    expect(app.$('#video-info').textContent).toMatch(/^untitled\.webm \(VP9 \+ OPUS\): 0:03 of video/);
    FakeWorker.script = [[{ type: 'error', message: 'no codec' }]];
    app.click('#video-go');
    await app.settle(10);
    expect(app.$('#video-info').textContent).toBe('Export failed: no codec');
    FakeWorker.script = [[]];
    app.click('#video-go');
    app.click('#video-go');
    await app.settle(10);
    expect(app.$('#video-info').textContent).toBe('Export cancelled.');
  });

  it('turns video off where the browser can neither encode nor record', async () => {
    app = await bootApp();
    expect(app.$<HTMLButtonElement>('#video-go').disabled).toBe(true);
    expect(app.$('#video-info').textContent).toBe("This browser can't make videos. Chrome, Edge and Firefox can.");
  });
});

describe('autosave', () => {
  it('saves a version after edits and lists it in the Save dialog', async () => {
    app = await bootApp();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    app.key('Space');
    app.key('KeyQ');
    vi.advanceTimersByTime(2000);
    vi.useRealTimers();
    await app.settle(20);
    app.click('#save');
    await app.settle(20);
    const items = [...app.$('#autosave-list').children];
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('untitled');
  });

  it('picks up the last session on start, and restores older versions', async () => {
    const indexedDB = new IDBFactory();
    app = await bootApp({ indexedDB });
    vi.stubGlobal('indexedDB', indexedDB);
    const { writeAutosave } = await import('./storage/autosave.ts');
    await writeAutosave('Older', saveXm(titled('Older')), true, 1_000);
    await writeAutosave('Latest', saveXm(titled('Latest')), true, 200_000);
    app = await bootApp({ indexedDB });
    expect(app.$<HTMLInputElement>('#title').value).toBe('Latest');
    expect(app.status()).toMatch(/^Restored Latest from /);
    app.click('#save');
    await app.settle(20);
    const older = [...app.$('#autosave-list').children].find((li) => li.textContent!.includes('Older'))!;
    older.dispatchEvent(new MouseEvent('click'));
    await app.settle(10);
    expect(app.$<HTMLInputElement>('#title').value).toBe('Older');
    expect(app.$('#song-tabs').hidden).toBe(false);
  });

  it('lists nothing yet, or says when the browser keeps nothing', async () => {
    app = await bootApp();
    app.click('#save');
    await app.settle(10);
    expect(app.$('#autosave-list').textContent).toBe('Nothing saved yet.');
    app.dialog()!.close();
    app = await bootApp({ before: () => void vi.stubGlobal('indexedDB', undefined) });
    app.click('#save');
    await app.settle(10);
    expect(app.$('#autosave-list').textContent).toBe('Not available in this browser.');
  });
});

describe('song library', () => {
  it('lists the demo song, saves, renames, opens and deletes songs', async () => {
    app = await bootApp();
    app.$<HTMLInputElement>('#title').value = 'Mine';
    app.$('#title').dispatchEvent(new Event('change'));
    app.click('#songs-open');
    await app.settle(20);
    expect(app.$<HTMLInputElement>('#library-name').value).toBe('Mine');
    expect(app.$('#library-list').children).toHaveLength(1);
    app.click('#library-save');
    await app.settle(20);
    expect(app.status()).toBe('Saved Mine in this browser.');
    expect(app.$('#library-list').children).toHaveLength(2);
    expect(app.$('#library-list [aria-selected="true"]').textContent).toContain('Mine');
    // Saving under a name that exists asks first.
    app.$<HTMLInputElement>('#library-name').value = DEMO_SONG_NAME;
    app.$('#library-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await app.answer('Cancel');
    app.click('#library-rename');
    await app.answer('Rename', 'Yours');
    expect(app.$('#library-list').textContent).toContain('Yours');
    expect(app.$<HTMLInputElement>('#library-name').value).toBe('Yours');
    const demo = [...app.$('#library-list').children].find((li) => !li.textContent!.includes('Yours'))!;
    demo.dispatchEvent(new MouseEvent('click'));
    demo.dispatchEvent(new MouseEvent('dblclick'));
    await app.settle(20);
    expect(app.status()).toMatch(/^Opened /);
    expect(app.dialog()).toBeNull();
    app.click('#songs-open');
    await app.settle(20);
    app.click('#library-delete');
    await app.answer('Delete');
    expect(app.$('#library-list').children).toHaveLength(1);
    app.click('#library-delete');
    await app.answer('Delete');
    expect(app.$('#library-list').textContent).toBe('No songs saved here yet.');
    expect(app.$<HTMLButtonElement>('#library-open').disabled).toBe(true);
  });

  it('backs up the songs and restores a backup', async () => {
    app = await bootApp();
    app.click('#songs-open');
    await app.settle(20);
    app.click('#library-backup');
    await app.settle(20);
    const backup = app.downloads.at(-1)!;
    expect(backup.name).toMatch(/^chiptrackr-songs-\d{4}-\d\d-\d\d\.zip$/);
    expect(app.$('#library-info').textContent).toMatch(/^Saved 1 song to chiptrackr-songs-/);
    await app.pick('#library-restore-file', file(backup.bytes, 'backup.zip'));
    await app.settle(20);
    expect(app.$('#library-info').textContent).toBe('Added 0 songs from backup.zip. Already here: 1 song.');
    await app.pick('#library-restore-file', file(createZip([]), 'empty.zip'));
    expect(app.$('#library-info').textContent).toBe('No songs found in empty.zip.');
    await app.pick('#library-restore-file', file('junk', 'junk.zip'));
    expect(app.$('#library-info').textContent).toMatch(/^Could not restore junk\.zip: /);
    const click = vi.spyOn(app.$<HTMLInputElement>('#library-restore-file'), 'click').mockImplementation(() => {});
    app.click('#library-restore');
    expect(click).toHaveBeenCalled();
  });

  it('backs up everything from Setup, and offers the settings of a backup', async () => {
    app = await bootApp({ storage: { 'webtracker.jamName': 'Ann' } });
    app.click('#backup-all');
    await app.settle(20);
    const backup = app.downloads.at(-1)!;
    expect(backup.name).toMatch(/^chiptrackr-backup-/);
    expect(app.$('#setup-info').textContent).toMatch(/^Saved 1 song and the settings to /);
    localStorage.removeItem('webtracker.jamName');
    await app.pick('#backup-file', file(backup.bytes, 'all.zip'));
    await app.settle(20);
    expect(app.dialog()!.textContent).toContain('Replace the settings here with them?');
    await app.answer('Keep mine');
    expect(localStorage.getItem('webtracker.jamName')).toBeNull();
    await app.pick('#backup-file', file(backup.bytes, 'all.zip'));
    await app.settle(20);
    await app.answer('Replace and reload');
    await app.settle(20);
    expect(localStorage.getItem('webtracker.jamName')).toBe('Ann');
    expect(location.reload).toHaveBeenCalled();
  });
});

describe('share links', () => {
  it('packs the song into a link, copies it and sends it', async () => {
    app = await bootApp();
    app.click('#share-open');
    await app.settle(20);
    const url = app.$<HTMLInputElement>('#share-url').value;
    expect(url).toMatch(/#song=/);
    expect(app.$('#share-info').textContent).toMatch(/characters\. The song travels inside the link/);
    expect(app.$('#share-send').hidden).toBe(true);
    app.click('#share-copy');
    await app.settle();
    expect(app.clipboard).toEqual([url]);
    expect(app.$('#share-info').textContent).toBe('Link copied.');
    app.$<HTMLSelectElement>('#share-quality').value = 'small';
    app.$('#share-quality').dispatchEvent(new Event('change'));
    await app.settle(20);
    expect(app.$<HTMLInputElement>('#share-url').value).toMatch(/#song=/);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('no')) } });
    app.click('#share-copy');
    await app.settle();
    expect(app.$('#share-info').textContent).toBe('Select the link and copy it.');
  });

  it('sends the link or the file through the share sheet, and downloads what it will not take', async () => {
    const shared: ShareData[] = [];
    let refuse: string | null = null;
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        if (refuse) throw Object.assign(new Error('refused'), { name: refuse });
        shared.push(data);
      },
    });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    try {
      app = await bootApp();
      app.click('#share-open');
      await app.settle(20);
      expect(app.$('#share-send').hidden).toBe(false);
      app.click('#share-send');
      app.click('#share-file');
      await app.settle();
      expect(shared.map((d) => (d.files ? 'file' : d.url))).toEqual([app.$<HTMLInputElement>('#share-url').value, 'file']);
      refuse = 'AbortError';
      app.click('#share-send');
      await app.settle();
      refuse = 'NotAllowedError';
      app.click('#share-file');
      await app.settle();
      expect(app.downloads.at(-1)!.name).toBe('untitled.xm');
      app.click('#share-send');
      await app.settle();
      expect(app.$('#share-info').textContent).toBe('Could not share: refused');
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
      app.click('#share-file');
      expect(app.$('#share-info').textContent).toMatch(/^This browser can't send untitled\.xm directly/);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).share;
      delete (navigator as unknown as Record<string, unknown>).canShare;
    }
  });

  it('opens a shared song from the address, now and when the address changes', async () => {
    const text = await encodeShare(saveXm(titled('Shared')), { format: 'xm', formatName: 'XM', channelPanning: [128, 128, 128, 128] });
    app = await bootApp({ hash: `#song=${text}` });
    expect(app.$<HTMLInputElement>('#title').value).toBe('Shared');
    expect(app.status()).toBe('Opened the shared song Shared.');
    expect(location.hash).toBe('');
    history.replaceState(null, '', '/#song=broken');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await app.settle(20);
    expect(app.status()).toMatch(/^Could not open the shared song: /);
    app = await bootApp({ hash: '#song=broken' });
    expect(app.status()).toMatch(/^Could not open the shared song: /);
  });
});

describe('song tabs', () => {
  it('opens each song in its own tab, switches with Alt+PageDown and closes them', async () => {
    app = await bootApp();
    app.key('Space');
    app.key('KeyQ');
    await app.pick('#file', xmFile('Second'));
    const tabs = () => [...app.$('#song-tabs').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs().map((b) => b.textContent)).toEqual(['untitled*', 'Second']);
    app.key('PageDown', { altKey: true });
    await app.settle();
    expect(app.status()).toBe('Song 1 of 2: untitled.');
    expect(app.cell(0, 0)).toContain('C-5');
    tabs()[1]!.click();
    await app.settle();
    expect(app.$<HTMLInputElement>('#title').value).toBe('Second');
    // Closing the other, changed song asks first.
    const close = () => [...app.$('#song-tabs').querySelectorAll<HTMLButtonElement>('button:not([role])')];
    close()[0]!.click();
    await app.answer('Cancel');
    expect(tabs()).toHaveLength(2);
    close()[0]!.click();
    await app.answer('Close');
    expect(app.$('#song-tabs').hidden).toBe(true);
    // The last song makes way for a new one.
    await app.pick('#file', xmFile('Third'));
    app.key('PageUp', { altKey: true });
    await app.settle();
    close()[0]!.click();
    await app.settle();
    expect(app.$<HTMLInputElement>('#title').value).toBe('Third');
    app.click('#new');
    await app.settle();
    expect(app.status()).toBe('New song: 4 channels, five chip instruments.');
  });

  it('asks before closing the song in the editor with changes, and warns before leaving the page', async () => {
    app = await bootApp();
    await app.pick('#file', xmFile('One'));
    await app.pick('#file', xmFile('Two'));
    app.key('Space');
    app.key('KeyQ');
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    const close = () => [...app.$('#song-tabs').querySelectorAll<HTMLButtonElement>('button:not([role])')];
    close()[1]!.click();
    await app.answer('Close');
    expect(app.$<HTMLInputElement>('#title').value).toBe('One');
    close()[0]!.click();
    await app.settle();
    expect(app.$<HTMLInputElement>('#title').value).toBe('');
    const stay = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(stay);
    expect(stay.defaultPrevented).toBe(false);
  });
});

describe('loaded songs', () => {
  it('keeps the format of a loaded MOD for saving and sharing', async () => {
    app = await bootApp();
    await app.pick('#file', file(saveMod(titled('Amiga')).bytes, 'a.mod'));
    expect(loadModule(saveXm(app.song()).slice().buffer).title).toBe('Amiga');
  });
});
