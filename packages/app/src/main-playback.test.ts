// @vitest-environment happy-dom
import { createSong, Player, type PlayerState } from '@webtracker/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { contextOf, setBox } from './test-dom.ts';
import { bootApp, fakeAudio, shutdownApp, type App } from './test-app.ts';

/**
 * Playback on the tracker page: the transport, what the worklet reports
 * back, the scopes, and the instrument and sample panels.
 */

let app: App;

afterEach(() => shutdownApp());

const start = new Player(createSong(), 48000).getState();
const state = (fields: Partial<PlayerState>): PlayerState => ({ ...start, playing: true, ...fields });
const settings = (fields: Record<string, unknown>) => ({ 'webtracker.settings': JSON.stringify(fields) });

describe('transport', () => {
  it('plays the song or the pattern from the current position, and stops', async () => {
    app = await bootApp();
    app.click('#play-song');
    await app.settle();
    expect(app.messages.at(-1)).toEqual({ type: 'play', loopPattern: false, order: 0, row: 0 });
    app.worklet({ type: 'state', state: state({}) });
    expect(app.$('#bar-play').textContent).toBe('Stop');
    app.click('#play-pattern');
    await app.settle();
    expect(app.messages.at(-1)).toMatchObject({ type: 'play', loopPattern: true });
    app.click('#stop');
    expect(app.messages.at(-1)).toEqual({ type: 'stop' });
    expect(app.$('#bar-play').textContent).toBe('Play');
    app.click('#bar-play');
    await app.settle();
    expect(app.messages.at(-1)).toMatchObject({ type: 'play', loopPattern: false });
    app.click('#bar-play');
    expect(app.messages.at(-1)).toEqual({ type: 'stop' });
  });

  it('plays from the cursor row with Ctrl+Enter, and steps row by row with Alt+Enter', async () => {
    app = await bootApp();
    app.key('ArrowDown');
    app.key('ArrowDown');
    app.key('Enter', { ctrlKey: true });
    await app.settle();
    expect(app.messages.at(-1)).toEqual({ type: 'play', loopPattern: true, order: 0, row: 2 });
    app.key('Enter', { ctrlKey: true, shiftKey: true });
    await app.settle();
    expect(app.messages.at(-1)).toEqual({ type: 'play', loopPattern: false, order: 0, row: 2 });
    app.worklet({ type: 'state', state: state({ row: 2 }) });
    app.key('Enter', { altKey: true });
    await app.settle();
    // A playing song stops first.
    expect(app.messages.slice(-2)).toEqual([{ type: 'stop' }, { type: 'playRow', order: 0, row: 2 }]);
    expect(app.cursor()).toEqual([3, 0]);
    app.key('Enter', { shiftKey: true });
    await app.settle();
    expect(app.messages.at(-1)).toMatchObject({ type: 'play', loopPattern: true });
    app.key('NumpadEnter');
    await app.settle();
    expect(app.messages.at(-1)).toMatchObject({ type: 'play', loopPattern: false });
  });

  it('stops with Space while playing in FT2 mode, and plays with Space in play mode', async () => {
    app = await bootApp();
    app.click('#play-song');
    await app.settle();
    app.worklet({ type: 'state', state: state({}) });
    app.key('Space');
    expect(app.messages.at(-1)).toEqual({ type: 'stop' });
    expect(app.$('#rec').getAttribute('aria-pressed')).toBe('false');

    app = await bootApp({ storage: settings({ space: 'play' }) });
    app.key('Space');
    await app.settle();
    expect(app.messages.at(-1)).toMatchObject({ type: 'play' });
    app.worklet({ type: 'state', state: state({}) });
    app.key('Space');
    expect(app.messages.at(-1)).toEqual({ type: 'stop' });
    // Shift+Space still switches edit mode.
    app.key('Space', { shiftKey: true });
    expect(app.$('#rec').getAttribute('aria-pressed')).toBe('true');
    // Outside the pattern, Space plays too.
    app.click('[data-view-target="instrument"]');
    app.key('Space');
    await app.settle();
    expect(app.messages.at(-1)).toMatchObject({ type: 'play' });
  });

  it('follows the playing row, pattern and order, unless follow is off', async () => {
    app = await bootApp();
    app.click('#order-ins');
    app.click('#order-inc');
    app.click('#orders li[data-index="0"]');
    app.click('#play-song');
    await app.settle();
    app.worklet({ type: 'row', state: state({ row: 5, tempo: 140, speed: 3 }), levels: [] });
    expect(app.cursor()).toEqual([5, 0]);
    expect([app.$('#bpm').textContent, app.$('#speed').textContent]).toEqual(['140', '03']);
    app.worklet({ type: 'row', state: state({ order: 1, pattern: 1, row: 0 }), levels: [] });
    expect(app.$('#pattern-no').textContent).toBe('01');
    expect(app.$('#orders li[data-index="1"]').getAttribute('aria-selected')).toBe('true');
    // Picking a position while playing moves playback there.
    app.click('#orders li[data-index="0"]');
    expect(app.messages.at(-1)).toEqual({ type: 'seek', order: 0 });
    app.key('KeyF', { ctrlKey: true });
    app.worklet({ type: 'row', state: state({ order: 0, row: 9 }), levels: [] });
    expect(app.cursor()).toEqual([0, 0]);
    // When playback ends the fields show the song's own tempo again.
    app.worklet({ type: 'state', state: state({ playing: false }) });
    expect(app.$('#bar-play').textContent).toBe('Play');
  });

  it('records into the playing row in edit mode', async () => {
    app = await bootApp();
    app.key('Space');
    app.click('#play-pattern');
    await app.settle();
    app.worklet({ type: 'row', state: state({ row: 7 }), levels: [] });
    app.key('KeyQ');
    expect(app.cell(7, 0)).toContain('C-5');
  });

  it('hands the voices playing to the editors', async () => {
    app = await bootApp();
    app.click('[data-view-target="sample"]');
    app.worklet({ type: 'voices', voices: [{ channel: 0, instrument: 1, sample: 0, note: 49, pos: 10, volEnvTick: 0, panEnvTick: 0 }] });
    app.click('[data-view-target="instrument"]');
    app.worklet({ type: 'voices', voices: [] });
    expect(app.$('#app').dataset.view).toBe('instrument');
  });
});

describe('scopes', () => {
  it('draws a flat line while stopped and the waves while playing', async () => {
    app = await bootApp();
    const canvases = [...app.$('#scopes').querySelectorAll('canvas')];
    for (const canvas of canvases) setBox(canvas, { width: 80, height: 40 });
    app.frame();
    const ctx = contextOf(canvases[0]!);
    expect(ctx.calls.filter((c) => c.op === 'fillRect')).toHaveLength(1);
    // Nothing changed, nothing is drawn again.
    ctx.clear();
    app.frame();
    expect(ctx.calls).toEqual([]);
    app.click('#play-song');
    await app.settle();
    const wave = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i / 8));
    app.worklet({ type: 'scopes', channels: [wave, wave, new Float32Array(1024), new Float32Array(100)] });
    app.frame();
    expect(ctx.calls.filter((c) => c.op === 'fillRect').length).toBeGreaterThan(10);
    // Scopes that arrive after stop are dropped.
    app.click('#stop');
    app.frame();
    ctx.clear();
    app.worklet({ type: 'scopes', channels: [wave] });
    app.frame();
    expect(ctx.calls).toEqual([]);
  });

  it('mutes a channel on click and solos it on right-click', async () => {
    app = await bootApp();
    const scope = (c: number) => app.$('#scopes').children[c] as HTMLElement;
    scope(1).querySelector('canvas')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(app.status()).toBe('Muted: 2');
    scope(1).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(app.status()).toBe('All channels on.');
    scope(2).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(app.status()).toBe('Muted: 1 2 4');
    scope(2).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(app.status()).toBe('All channels on.');
    // Clicks between the scopes do nothing.
    app.$('#scopes').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    app.$('#scopes').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(app.status()).toBe('All channels on.');
    // The worklet hears about it once audio runs.
    scope(0).click();
    app.click('#play-song');
    await app.settle();
    expect(app.messages).toContainEqual({ type: 'mute', muted: [true, false, false, false] });
  });
});

describe('instruments and samples', () => {
  it('picks instruments and samples from the lists and the arrows', async () => {
    app = await bootApp();
    app.click('#instrument-list li[data-index="3"]');
    expect(app.$('#ins-pick-no').textContent).toBe('03');
    expect(app.$('#ins-pick-name').textContent).toBeTruthy();
    app.click('#sample-list li[data-index="2"]');
    expect(app.$('#sample-list li[data-index="2"]').getAttribute('aria-selected')).toBe('true');
    app.click('#ins-next');
    expect(app.$('#ins-pick-no').textContent).toBe('04');
    // The arrows stop one past the last instrument with samples.
    for (let i = 0; i < 10; i++) app.click('#ins-next');
    expect(app.$('#ins-pick-no').textContent).toBe('06');
    for (let i = 0; i < 10; i++) app.click('#ins-prev');
    expect(app.$('#ins-pick-no').textContent).toBe('01');
    // A click beside the items does nothing.
    app.click('#instrument-list');
    expect(app.$('#ins-pick-no').textContent).toBe('01');
  });

  it('picks an instrument and a sample on phones', async () => {
    app = await bootApp();
    app.click('#ins-pick');
    const picker = app.$<HTMLDialogElement>('#ins-picker');
    expect(picker.open).toBe(true);
    expect(app.$('#picker-list').querySelectorAll('li.empty').length).toBeGreaterThan(100);
    app.click('#picker-list li[data-index="2"]');
    expect(picker.open).toBe(false);
    expect(app.$('#ins-pick-no').textContent).toBe('02');
    app.click('#ins-pick');
    expect(picker.classList.contains('one-sample')).toBe(true);
    // Only the buttons choose a sample.
    app.click('#picker-samples');
    expect(picker.open).toBe(true);
    app.click('#picker-samples [data-slot="0"]');
    expect(picker.open).toBe(false);
    app.click('#ins-pick');
    picker.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 }) as DOMRect;
    picker.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50, bubbles: true }));
    expect(picker.open).toBe(true);
    picker.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 50, bubbles: true }));
    expect(picker.open).toBe(false);
    // The picker refreshes when the instruments change while it is open.
    app.click('#ins-pick');
    app.key('KeyZ', { ctrlKey: true });
    app.click('#picker-library');
    expect(app.$<HTMLDialogElement>('#sample-library').open).toBe(true);
  });

  it('plays library sounds and loads them into the slot or as the instrument', async () => {
    app = await bootApp();
    app.click('[data-view-target="sample"]');
    const library = [...app.$('#editors').querySelectorAll('button')].find((b) => b.textContent === 'Library')!;
    library.click();
    app.click('#sample-library .list li[data-id="square"]');
    await app.settle();
    const audio = fakeAudio.last!;
    expect(audio.sources[0]).toMatchObject({ loop: true, started: true, stopped: true });
    app.click('#sample-library .list li[data-id="square"]');
    await app.settle();
    expect(audio.sources).toHaveLength(2);
    app.click('#sample-lib-load');
    expect(app.status()).toMatch(/from the sample library in 01\/0/);
    // Closing the dialog stops the sound.
    expect(audio.sources[1]!.stopped).toBe(true);
    app.click('#sample-list li[data-index="3"]');
    library.click();
    app.click('[data-category="drums"]');
    app.click('#sample-library .list li[data-id="kick"]');
    await app.settle();
    expect(audio.sources.at(-1)).toMatchObject({ loop: false, started: true });
    app.click('#sample-lib-instrument');
    expect(app.status()).toMatch(/from the sample library is instrument 01/);
    const song = app.song();
    expect(song.instruments[0]!.samples).toHaveLength(1);
  });

  it('switches between the pattern, sample and instrument editors', async () => {
    app = await bootApp();
    app.click('[data-view-target="sample"]');
    expect(app.$('#app').dataset.view).toBe('sample');
    expect(app.$('[data-view-target="sample"]').getAttribute('aria-selected')).toBe('true');
    app.click('#instrument-list li[data-index="2"]');
    app.click('[data-view-target="instrument"]');
    app.click('#sample-list li[data-index="1"]');
    app.click('[data-view-target="pattern"]');
    expect(app.$('#app').dataset.view).toBe('pattern');
  });
});

describe('phone layout', () => {
  it('opens and closes the menu sheet, and the tabs pick a panel', async () => {
    app = await bootApp();
    app.click('#bar-menu');
    expect(app.$('#app').classList.contains('sheet-open')).toBe(true);
    expect(app.$('#bar-menu').getAttribute('aria-expanded')).toBe('true');
    app.click('#sheet-backdrop');
    expect(app.$('#app').classList.contains('sheet-open')).toBe(false);
    app.click('#bar-menu');
    app.click('#play-song');
    expect(app.$('#app').classList.contains('sheet-open')).toBe(false);
    app.click('#bar-menu');
    app.key('Escape');
    expect(app.$('#app').classList.contains('sheet-open')).toBe(false);
    const tabs = [...document.querySelectorAll<HTMLElement>('[data-tab-target]')];
    tabs[1]!.click();
    expect(app.$('#app').dataset.tab).toBe(tabs[1]!.dataset.tabTarget);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
  });

  it('stands in for hidden controls with proxy buttons', async () => {
    app = await bootApp();
    app.click('#bar-rec');
    expect(app.$('#rec').getAttribute('aria-pressed')).toBe('true');
    expect(app.$('#bar-rec').getAttribute('aria-pressed')).toBe('true');
    app.click('[data-proxy-step="octave:1"]');
    expect(app.$('#octave').textContent).toBe('05');
    app.click('#keys-proxy');
    expect(app.$('#keys-toggle').getAttribute('aria-pressed')).toBe('true');
    app.click('#keys-toggle');
    expect(app.$('#keys-proxy').getAttribute('aria-pressed')).toBe('false');
  });

  it('plays notes from the on-screen piano', async () => {
    app = await bootApp();
    const key = app.$('#piano [data-note="49"]');
    document.elementFromPoint = () => key;
    key.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    await app.settle();
    expect(app.messages.at(-1)).toMatchObject({ type: 'noteOn', note: Number(key.dataset.note) });
    key.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }));
    expect(app.messages.at(-1)).toEqual({ type: 'noteOff' });
  });
});
