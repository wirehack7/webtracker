// @vitest-environment happy-dom
import { createSong, readCell, writeCell } from '@webtracker/engine';
import { saveXm } from '@webtracker/formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootApp, shutdownApp, type App } from './test-app.ts';
import { SEEN_KEY } from './ui/changelog.ts';

/**
 * Setup, the colour editor, MIDI, the advanced edit tools and the help
 * dialogs on the tracker page. MIDI devices are stand-ins; real hardware
 * is not part of it.
 */

let app: App;

afterEach(() => shutdownApp());

const select = (selector: string, value: string) => {
  const element = app.$<HTMLSelectElement | HTMLInputElement>(selector);
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
const check = (selector: string, on: boolean) => {
  const box = app.$<HTMLInputElement>(selector);
  box.checked = on;
  box.dispatchEvent(new Event('change', { bubbles: true }));
};
const stored = () => JSON.parse(localStorage.getItem('webtracker.settings') ?? '{}') as Record<string, unknown>;
const file = (text: string, name: string) => new File([text], name);

describe('Setup', () => {
  it('shows the settings, and saves and applies each change', async () => {
    app = await bootApp();
    app.click('#setup-open');
    expect(app.dialog()!.id).toBe('setup');
    expect(app.$<HTMLSelectElement>('#set-theme').value).toBe('classic');
    expect(app.$('#set-separation-value').textContent).toMatch(/^\d+%$/);
    app.messages.length = 0;
    select('#set-theme', 'amber');
    expect(document.documentElement.dataset.theme).toBe('amber');
    expect(stored()).toMatchObject({ theme: 'amber' });
    select('#set-separation', '40');
    expect(app.$('#set-separation-value').textContent).toBe('40%');
    select('#set-amplify', '150');
    expect(app.$('#set-amplify-value').textContent).toBe('150%');
    select('#set-resampler', 'sinc');
    check('#set-ramps', false);
    check('#set-karplus', true);
    select('#set-beat', '3');
    select('#set-bar', '12');
    select('#set-space', 'play');
    check('#set-prospective', true);
    check('#set-wrap', true);
    check('#set-tabs', false);
    select('#set-raw', app.$<HTMLSelectElement>('#set-raw').options[1]!.value);
    select('#set-ui-size', 'large');
    expect(stored()).toMatchObject({ stereoSeparation: 40, amplify: 150, resampler: 'sinc', volumeRamps: false, karplusStrong: true, beat: 3, bar: 12, space: 'play', prospective: true, wrapCursor: true, songTabs: false, uiSize: 'large' });
    // Each change sends the mixer settings to the engine once audio runs.
    app.key('KeyQ');
    await app.settle();
    select('#set-separation', '60');
    expect(app.messages.at(-1)).toEqual({ type: 'mixer', resampler: 'sinc', stereoSeparation: 60, volumeRamps: false, amplify: 150, karplusStrong: true });
    expect(document.documentElement.style.getPropertyValue('--px')).toMatch(/px$/);
  });

  it('reloads for a new language when asked, and later otherwise', async () => {
    app = await bootApp();
    app.click('#setup-open');
    select('#set-language', 'de');
    expect(stored()).toMatchObject({ language: 'de' });
    await app.answer('Later');
    expect(location.reload).not.toHaveBeenCalled();
    select('#set-language', 'fi');
    await app.answer('Reload');
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1));
    // Leaving for the reload does not ask to keep the song.
    const leaving = new Event('beforeunload', { cancelable: true });
    dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(false);
  });

  it('asks before leaving with unsaved changes', async () => {
    app = await bootApp();
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    app.key('Space');
    app.key('KeyQ');
    expect(leave()).toBe(true);
  });
});

describe('colours', () => {
  it('changes one colour, exports, imports and resets the scheme', async () => {
    app = await bootApp();
    app.click('#setup-open');
    const first = app.$<HTMLInputElement>('#colour-grid input');
    const name = first.title;
    first.value = '#123456';
    first.dispatchEvent(new Event('input'));
    first.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.documentElement.style.getPropertyValue(name)).toBe('#123456');
    expect(stored()).toMatchObject({ colors: { [name]: '#123456' } });

    app.click('#colours-export');
    const exported = JSON.parse(new TextDecoder().decode(app.downloads.at(-1)!.bytes)) as { theme: string; colors: Record<string, string> };
    expect(app.downloads.at(-1)!.name).toBe('colours.json');
    expect(exported.theme).toBe('classic');
    expect(Object.keys(exported.colors)).toContain(name);

    await app.pick('#colours-file', file(JSON.stringify({ theme: 'mint', colors: { [name]: '#abcdef' } }), 'mine.json'));
    expect(app.status()).toBe('Loaded colours from mine.json.');
    expect(document.documentElement.dataset.theme).toBe('mint');
    expect(app.$<HTMLSelectElement>('#set-theme').value).toBe('mint');
    expect(document.documentElement.style.getPropertyValue(name)).toBe('#abcdef');

    await app.pick('#colours-file', file('not json', 'junk.json'));
    expect(app.status()).toBe('junk.json is not a colour file.');
    await app.answer('OK');

    app.click('#colours-reset');
    expect(app.status()).toBe('Colours reset to the scheme.');
    expect(document.documentElement.style.getPropertyValue(name)).toBe('');
    expect(stored()).toMatchObject({ colors: {} });

    const click = vi.spyOn(app.$<HTMLInputElement>('#colours-file'), 'click').mockImplementation(() => {});
    app.click('#colours-import');
    expect(click).toHaveBeenCalled();
  });
});

describe('MIDI', () => {
  class Input {
    onmidimessage: ((event: { data: Uint8Array }) => void) | null = null;
    constructor(readonly name: string | null) {}
    play(...bytes: number[]) {
      this.onmidimessage?.({ data: new Uint8Array(bytes) });
    }
  }

  it('says when the browser has no Web MIDI', async () => {
    app = await bootApp();
    app.click('#setup-open');
    check('#set-midi', true);
    await app.settle();
    expect(app.$('#setup-info').textContent).toBe('This browser has no Web MIDI.');
  });

  it('plays notes from MIDI inputs, with velocity when asked', async () => {
    const keys = new Input('Keys');
    const access = { inputs: new Map([['1', keys], ['2', new Input(null)]]), onstatechange: null as (() => void) | null };
    app = await bootApp({ storage: { 'webtracker.settings': JSON.stringify({ midi: true }) }, before: () => void Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access }) });
    await app.settle();
    expect(app.$('#setup-info').textContent).toBe('MIDI: Keys, MIDI input');
    app.key('KeyQ');
    await app.settle();
    app.messages.length = 0;
    keys.play(0x90, 60, 100);
    expect(app.messages.at(-1)).toMatchObject({ type: 'noteOn', note: 49 });
    keys.play(0x80, 60, 0);
    expect(app.messages.at(-1)).toEqual({ type: 'noteOff' });
    // Out of range notes are left alone.
    keys.play(0x90, 2, 100);
    expect(app.messages.at(-1)).toEqual({ type: 'noteOff' });
    // A note on with no velocity is a note off.
    keys.play(0x90, 62, 100);
    keys.play(0x90, 62, 0);
    expect(app.messages.at(-1)).toEqual({ type: 'noteOff' });
    // Velocity sets the volume of recorded notes.
    app.click('#setup-open');
    check('#set-velocity', true);
    app.dialog()!.close();
    app.key('Space');
    keys.play(0x90, 60, 64);
    expect(app.cell(0, 0)).toMatch(/^C-401 *2/);
    // A device plugged in later is heard too.
    const later = new Input('Pads');
    access.inputs.set('3', later);
    access.onstatechange!();
    expect(later.onmidimessage).not.toBeNull();
    // Turning MIDI off stops listening.
    app.click('#setup-open');
    check('#set-midi', false);
    expect(keys.onmidimessage).toBeNull();
    delete (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess;
  });

  it('says when MIDI is not allowed or nothing is plugged in', async () => {
    let allowed = false;
    const before = () =>
      void Object.defineProperty(navigator, 'requestMIDIAccess', {
        configurable: true,
        value: async () => {
          if (!allowed) throw new Error('denied');
          return { inputs: new Map(), onstatechange: null };
        },
      });
    app = await bootApp({ storage: { 'webtracker.settings': JSON.stringify({ midi: true }) }, before });
    await app.settle();
    expect(app.$('#setup-info').textContent).toBe('MIDI not allowed: denied');
    allowed = true;
    app.click('#setup-open');
    check('#set-wrap', true);
    await app.settle();
    expect(app.$('#setup-info').textContent).toBe('MIDI is on; no input device connected yet.');
    delete (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess;
  });
});

describe('advanced edit tools', () => {
  /** A song with notes on two channels of pattern 0, opened as a file. */
  async function withNotes() {
    const song = createSong(4);
    for (const row of [0, 4, 8]) {
      writeCell(song, song.patterns[0]!, row, 0, { note: 49, instrument: 1, volume: 0x50 });
      writeCell(song, song.patterns[0]!, row, 1, { note: 52, instrument: 2, volume: 0x50 });
    }
    await app.pick('#file', new File([saveXm(song) as BlobPart], 'notes.xm'));
  }

  it('transposes, remaps instruments and scales volumes over a range', async () => {
    app = await bootApp();
    await withNotes();
    app.click('#edit-tools-open');
    expect(app.dialog()!.id).toBe('edit-tools');
    expect(app.$<HTMLSelectElement>('#edit-range').value).toBe('track');
    expect(app.$<HTMLOptionElement>('#edit-range option[value="selection"]').disabled).toBe(true);
    expect(app.$('#edit-info').textContent).toBe('Applies to the range above; Ctrl+Z undoes it.');

    app.$<HTMLInputElement>('#tr-amount').value = '12';
    app.click('#tr-go');
    expect(app.$('#edit-info').textContent).toBe('Transpose: 3 notes changed.');
    expect(app.status()).toBe('Transpose: 3 notes changed.');
    expect(app.cell(0, 0)).toMatch(/^C-5/);
    expect(app.cell(0, 1)).toMatch(/^D#4/);
    // Zero does nothing at all.
    app.$<HTMLInputElement>('#tr-amount').value = '0';
    app.click('#tr-go');
    expect(app.$('#edit-info').textContent).toBe('Transpose: 3 notes changed.');

    app.$<HTMLSelectElement>('#edit-range').value = 'pattern';
    app.$<HTMLInputElement>('#rm-from').value = '02';
    app.$<HTMLInputElement>('#rm-to').value = '05';
    app.click('#rm-go');
    expect(app.$('#edit-info').textContent).toBe('Remap instrument: 3 cells changed.');
    expect(app.cell(4, 1)).toMatch(/^D#405/);
    app.click('#rm-go');
    expect(app.$('#edit-info').textContent).toBe('Remap instrument: nothing to change.');
    app.$<HTMLInputElement>('#rm-to').value = 'zz';
    app.click('#rm-go');
    expect(app.$('#edit-info').textContent).toBe('Instrument numbers are hex, 01 to 80.');

    app.$<HTMLSelectElement>('#edit-range').value = 'song';
    app.$<HTMLInputElement>('#sc-start').value = '50';
    app.$<HTMLInputElement>('#sc-end').value = '50';
    app.click('#sc-go');
    expect(app.$('#edit-info').textContent).toBe('Scale volume: 6 volumes changed.');
    const song = app.song();
    expect(readCell(song, song.patterns[0]!, 0, 0).volume).toBe(0x10 + 0x20);
    // Ctrl+Z undoes the whole tool at once.
    app.dialog()!.close();
    app.key('KeyZ', { ctrlKey: true });
    const undone = app.song();
    expect(readCell(undone, undone.patterns[0]!, 8, 1).volume).toBe(0x50);
  });

  it('works on the selection when there is one, and opens Song stats', async () => {
    app = await bootApp();
    await withNotes();
    app.key('ArrowDown', { shiftKey: true });
    app.click('#edit-tools-open');
    expect(app.$<HTMLSelectElement>('#edit-range').value).toBe('selection');
    app.$<HTMLInputElement>('#tr-amount').value = '-1';
    app.click('#tr-go');
    expect(app.$('#edit-info').textContent).toBe('Transpose: 1 notes changed.');
    app.$<HTMLInputElement>('#tr-amount').value = '1';
    app.$<HTMLInputElement>('#tr-ins').value = '09';
    app.click('#tr-go');
    expect(app.$('#edit-info').textContent).toBe('Transpose: nothing to change.');
    app.click('#edit-stats');
    expect(app.dialog()!.id).toBe('stats-dialog');
  });

  it('optimizes the song from Song stats as one undoable edit', async () => {
    app = await bootApp();
    await withNotes();
    app.click('#stats-open');
    expect(app.dialog()!.id).toBe('stats-dialog');
    app.click('#cu-go');
    expect(app.status()).toBe('Song optimized; Ctrl+Z undoes it.');
  });
});

describe('help and about', () => {
  it('opens help at the effect under the cursor, and What’s new and About', async () => {
    app = await bootApp();
    app.click('#help-open');
    expect(app.dialog()!.id).toBe('help');
    app.dialog()!.close();
    // Move to the effect column of a cell with an effect.
    for (let i = 0; i < 4; i++) app.key('ArrowRight');
    app.click('#help-open');
    expect(app.dialog()!.id).toBe('help');
    app.dialog()!.close();
    app.click('#whats-new-open');
    expect(app.dialog()!.id).toBe('whats-new');
    app.dialog()!.close();
    expect(app.$('#about-info').querySelectorAll('a')).toHaveLength(3);
    app.click('#brand-about');
    expect(app.dialog()!.id).toBe('about');
    app.dialog()!.close();
    app.click('#about-open');
    expect(app.dialog()!.id).toBe('about');
  });

  it('shows What’s new once to a returning visitor after an update', async () => {
    app = await bootApp({ storage: { 'webtracker.settings': '{}', [SEEN_KEY]: '0' } });
    expect(app.dialog()?.id).toBe('whats-new');
  });
});
