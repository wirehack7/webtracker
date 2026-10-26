// @vitest-environment happy-dom
import { LIBRARY_CATEGORIES, SAMPLE_LIBRARY } from '@webtracker/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contextOf, installDom, loadPage } from '../test-dom.ts';
import { mountSampleLibrary, SOUND_DESCRIPTIONS, type SampleLibrary, type SampleLibraryHost } from './sample-library.ts';

/** The Sample library dialog, on the markup of the real page. */

let dialog: HTMLDialogElement;
let host: { [K in keyof SampleLibraryHost]: ReturnType<typeof vi.fn> };
let library: SampleLibrary;

beforeEach(async () => {
  installDom();
  await loadPage('index.html', '#sample-library');
  dialog = document.querySelector('dialog')!;
  host = { audition: vi.fn(), loadSample: vi.fn(), loadInstrument: vi.fn() };
  library = mountSampleLibrary(dialog, host as unknown as SampleLibraryHost);
});

const items = () => [...dialog.querySelectorAll<HTMLLIElement>('.list li')];
const item = (id: string) => items().find((li) => li.dataset.id === id)!;
const tab = (category: string) => dialog.querySelector<HTMLButtonElement>(`[data-category="${category}"]`)!;
const loadSample = () => dialog.querySelector<HTMLButtonElement>('#sample-lib-load')!;
const loadInstrument = () => dialog.querySelector<HTMLButtonElement>('#sample-lib-instrument')!;
const info = () => dialog.querySelector('.sample-lib-info')!.textContent;

describe('sample library', () => {
  it('has a description for every sound', () => {
    expect(SAMPLE_LIBRARY.filter((s) => !SOUND_DESCRIPTIONS[s.id]).map((s) => s.id)).toEqual([]);
  });

  it('lists the chip sounds first, each with its waveform, and nothing picked', () => {
    library.open();
    expect(dialog.open).toBe(true);
    expect([...dialog.querySelectorAll('.sample-lib-tabs button')].map((b) => (b as HTMLElement).dataset.category)).toEqual(LIBRARY_CATEGORIES);
    expect(tab('chip').getAttribute('aria-pressed')).toBe('true');
    expect(items().map((li) => li.dataset.id)).toEqual(SAMPLE_LIBRARY.filter((s) => s.category === 'chip').map((s) => s.id));
    const thumb = items()[0]!.querySelector('canvas')!;
    expect(contextOf(thumb).calls.filter((c) => c.op === 'lineTo')).toHaveLength(64);
    expect(loadSample().disabled).toBe(true);
    expect(loadInstrument().disabled).toBe(true);
    expect(info()).toMatch(/^Tap a sound/);
  });

  it('plays a sound on a tap and says what it is good for', () => {
    item('square').querySelector('.name')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.audition).toHaveBeenCalledOnce();
    expect(item('square').getAttribute('aria-selected')).toBe('true');
    expect(info()).toBe(SOUND_DESCRIPTIONS.square);
    expect(loadSample().disabled).toBe(false);
    // The same made sound is played again; a tap between items does nothing.
    item('square').click();
    expect(host.audition.mock.calls[1]![0]).toBe(host.audition.mock.calls[0]![0]);
    dialog.querySelector('.list')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.audition).toHaveBeenCalledTimes(2);
  });

  it('loads a fresh copy into the slot or as the instrument, and closes', () => {
    library.open();
    item('sine').click();
    loadSample().click();
    expect(dialog.open).toBe(false);
    const loaded = host.loadSample.mock.calls[0]![0];
    expect(loaded.data.length).toBeGreaterThan(0);
    expect(loaded).not.toBe(host.audition.mock.calls[0]![0]);
    library.open();
    // The pick is kept and shown again.
    expect(item('sine').getAttribute('aria-selected')).toBe('true');
    loadInstrument().click();
    expect(host.loadInstrument.mock.calls[0]![0].samples).toHaveLength(1);
    expect(dialog.open).toBe(false);
  });

  it('loads on a double-click, but only once something is picked', () => {
    dialog.querySelector('.list')!.dispatchEvent(new MouseEvent('dblclick'));
    expect(host.loadSample).not.toHaveBeenCalled();
    item('saw').click();
    item('saw').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(host.loadSample).toHaveBeenCalledOnce();
  });

  it('switches categories and drops a pick from another one', () => {
    item('square').click();
    tab('drums').click();
    expect(tab('drums').getAttribute('aria-pressed')).toBe('true');
    expect(tab('chip').getAttribute('aria-pressed')).toBe('false');
    expect(items().every((li) => SAMPLE_LIBRARY.find((s) => s.id === li.dataset.id)!.category === 'drums')).toBe(true);
    expect(loadSample().disabled).toBe(true);
    // Disabled buttons do nothing even when clicked from code.
    loadSample().disabled = false;
    loadSample().click();
    loadInstrument().disabled = false;
    loadInstrument().click();
    expect(host.loadSample).not.toHaveBeenCalled();
    expect(host.loadInstrument).not.toHaveBeenCalled();
  });

  it('closes on a tap beside it, not on one inside', () => {
    library.open();
    dialog.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 }) as DOMRect;
    dialog.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50, bubbles: true }));
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent('click', { clientX: 150, clientY: 50, bubbles: true }));
    expect(dialog.open).toBe(false);
  });
});
