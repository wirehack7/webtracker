// @vitest-environment happy-dom
import { NOTE_KEY_OFF, readCell } from '@webtracker/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { bootApp, fakeAudio, shutdownApp, type App } from './test-app.ts';

/**
 * The whole tracker page, driven by keys and clicks the way a user would:
 * the song fields, the order list, note and value entry, and the block keys.
 * Cells read as note, instrument, volume and effect, e.g. 'C-501..C20'.
 */

let app: App;

afterEach(() => shutdownApp());

const EMPTY = '---.......';
/** Holds Shift on a step button the way a mouse does: pointerdown, then click. */
const shiftClick = (selector: string) => {
  app.$(selector).dispatchEvent(new MouseEvent('pointerdown', { shiftKey: true, bubbles: true }));
  app.click(selector, { shiftKey: true });
};
const stepButton = (step: string) => `[data-step="${step}"]`;
/** Cell `channel` of `row` in the saved song. */
const saved = (row: number, channel: number) => {
  const song = app.song();
  return readCell(song, song.patterns[song.orders[0]!]!, row, channel);
};

describe('tracker page', () => {
  it('starts with a new four-channel song', async () => {
    app = await bootApp();
    expect(app.$('#channels').textContent).toBe('04');
    expect(app.$('#bpm').textContent).toBe('125');
    expect(app.$('#speed').textContent).toBe('06');
    expect(app.$<HTMLInputElement>('#title').value).toBe('');
    expect(app.$('#orders').children).toHaveLength(1);
    expect(app.$('#instrument-list').children).toHaveLength(128);
    expect(app.$('#scopes').children).toHaveLength(4);
    expect(app.cell(0, 0)).toBe(EMPTY);
    expect(app.status()).toBe('Press a key or tap the piano to start audio.');
  });

  it('starts audio on the first key and plays the note', async () => {
    app = await bootApp();
    // A key let go before audio is ready plays nothing.
    app.key('KeyW');
    await app.settle();
    expect(app.messages.map((m) => m.type)).toEqual(['load', 'mute', 'mixer']);
    app.messages.length = 0;
    app.keyEvent('keydown', 'KeyQ');
    await app.settle();
    expect(app.messages).toEqual([{ type: 'noteOn', note: 61, instrument: 1 }]);
    expect(app.status()).toBe('C-5  Instr 01  Channel 1');
    app.keyEvent('keyup', 'KeyQ');
    expect(app.messages.at(-1)).toEqual({ type: 'noteOff' });
    // Releasing a key that is not sounding does nothing.
    app.keyEvent('keyup', 'KeyE');
    expect(app.messages).toHaveLength(2);
  });

  it('says when audio is running, unless something else was said meanwhile', async () => {
    app = await bootApp();
    app.click('#stop');
    await app.settle();
    expect(app.status()).toBe('Audio running at 48000 Hz.');
  });

  it('says so when audio cannot start, and tries again on the next play', async () => {
    app = await bootApp();
    fakeAudio.fail = true;
    app.click('#play-song');
    await app.settle();
    expect(app.status()).toBe('Audio could not start: Error: no worklet');
    fakeAudio.fail = false;
    app.click('#play-song');
    await app.settle();
    expect(app.messages.map((m) => m.type)).toContain('play');
  });
});

describe('song fields', () => {
  it('steps tempo, speed, step and octave within their limits', async () => {
    app = await bootApp();
    app.click(stepButton('bpm:1'));
    app.click(stepButton('speed:-1'));
    expect([app.$('#bpm').textContent, app.$('#speed').textContent]).toEqual(['126', '05']);
    for (let i = 0; i < 10; i++) app.click(stepButton('speed:-1'));
    expect(app.$('#speed').textContent).toBe('01');
    app.click(stepButton('add:1'));
    expect(app.$('#add').textContent).toBe('02');
    expect(app.$('#pad-step span').textContent).toBe('2');
    app.click('[data-proxy-step="add:-1"]');
    expect(app.$('#add').textContent).toBe('01');
    app.click(stepButton('octave:1'));
    expect(app.$('#octave').textContent).toBe('05');
    expect(app.$('#bar-octave').textContent).toBe('Oct 5');
    const song = app.song();
    expect([song.initialTempo, song.initialSpeed]).toEqual([126, 1]);
  });

  it('adds channels at once and asks before removing any', async () => {
    app = await bootApp();
    app.click(stepButton('channels:1'));
    expect(app.$('#channels').textContent).toBe('05');
    expect(app.status()).toBe('5 channels.');
    shiftClick(stepButton('channels:1'));
    expect(app.$('#channels').textContent).toBe('07');
    expect(app.$('#scopes').children).toHaveLength(7);
    app.$(stepButton('channels:-1')).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    app.click(stepButton('channels:-1'));
    expect(app.dialog()!.textContent).toContain('Remove channel 7 from every pattern?');
    await app.answer('Cancel');
    expect(app.$('#channels').textContent).toBe('07');
    shiftClick(stepButton('channels:-1'));
    expect(app.dialog()!.textContent).toContain('Remove channels 6–7 from every pattern?');
    await app.answer('Remove');
    expect(app.$('#channels').textContent).toBe('05');
    expect(app.song().channels).toBe(5);
  });

  it('keeps the title, and leaves the field on Enter', async () => {
    app = await bootApp();
    const title = app.$<HTMLInputElement>('#title');
    title.focus();
    title.value = 'Pixel Sunrise';
    title.dispatchEvent(new Event('change'));
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.activeElement).not.toBe(title);
    expect(app.song().title).toBe('Pixel Sunrise');
    app.key('KeyZ', { ctrlKey: true });
    expect(title.value).toBe('');
    expect(app.status()).toMatch(/^Undo: /);
    // Ctrl+Shift+Z and Ctrl+Y both redo.
    app.key('KeyZ', { ctrlKey: true, shiftKey: true });
    expect(title.value).toBe('Pixel Sunrise');
    expect(app.status()).toMatch(/^Redo: /);
    app.key('KeyZ', { ctrlKey: true, shiftKey: true });
    expect(app.status()).toBe('Nothing to redo.');
    app.key('KeyZ', { ctrlKey: true });
    app.key('KeyY', { ctrlKey: true });
    expect(title.value).toBe('Pixel Sunrise');
    app.key('KeyY', { ctrlKey: true });
    expect(app.status()).toBe('Nothing to redo.');
    // Ctrl+E opens the advanced edit tools.
    app.key('KeyE', { ctrlKey: true });
    expect(app.dialog()!.id).toBe('edit-tools');
  });
});

describe('order list and patterns', () => {
  it('inserts, deletes and renumbers positions', async () => {
    app = await bootApp();
    app.click('#order-inc');
    app.click('#order-ins');
    app.click('#order-inc');
    expect([...app.$('#orders').children].map((li) => li.textContent)).toEqual(['00 01', '01 02']);
    expect(app.$('#pattern-no').textContent).toBe('02');
    app.click('#orders li[data-index="0"]');
    expect(app.$('#pattern-no').textContent).toBe('01');
    app.click('#order-dec');
    app.click('#order-dec');
    app.click('#order-del');
    expect([...app.$('#orders').children].map((li) => li.textContent)).toEqual(['00 02']);
    expect(app.song().orders).toEqual([2]);
  });

  it('picks, makes and clones patterns from the pattern list', async () => {
    app = await bootApp();
    app.key('Space');
    app.key('KeyQ');
    app.click('#pat-pick');
    expect(app.dialog()!.id).toBe('pat-picker');
    expect(app.$('#pat-list').children.length).toBeGreaterThan(0);
    expect(app.$('#pat-pos').textContent).toBe('00');
    expect(app.$<HTMLButtonElement>('#pat-pos-prev').disabled).toBe(true);
    app.click('#pat-clone');
    expect(app.dialog()).toBeNull();
    expect(app.$('#pattern-no').textContent).toBe('01');
    expect(app.cell(0, 0)).toContain('C-5');
    app.click('#pat-pick');
    app.click('#pat-new');
    expect(app.$('#pattern-no').textContent).toBe('02');
    expect(app.cell(0, 0)).toBe(EMPTY);
    app.click('#pat-pick');
    app.click('#pat-list li[data-index="0"]');
    expect(app.$('#pattern-no').textContent).toBe('00');
    // Positions can be stepped through from the list.
    app.click('#order-ins');
    app.click('#pat-pick');
    app.click('#pat-pos-prev');
    expect(app.$('#pat-pos').textContent).toBe('00');
    app.click('#pat-pos-next');
    expect(app.$('#pat-pos').textContent).toBe('01');
    // A tap beside the list closes it.
    const picker = app.$<HTMLDialogElement>('#pat-picker');
    picker.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 }) as DOMRect;
    picker.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50, bubbles: true }));
    expect(picker.open).toBe(true);
    picker.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 50, bubbles: true }));
    expect(picker.open).toBe(false);
  });

  it('changes the pattern length by one or sixteen rows', async () => {
    app = await bootApp();
    app.click('#len-dec');
    expect(app.$('#pattern-len').textContent).toBe('63');
    expect(app.$('#len-proxy').textContent).toBe('63');
    app.click('#len-inc', { shiftKey: true });
    expect(app.$('#pattern-len').textContent).toBe('79');
    app.click('[data-proxy="len-dec"]');
    expect(app.song().patterns[0]!.rows).toBe(78);
  });
});

describe('note and value entry', () => {
  it('moves the cursor with the arrow, page and tab keys', async () => {
    app = await bootApp();
    app.key('ArrowDown');
    app.key('ArrowDown');
    expect(app.cursor()).toEqual([2, 0]);
    app.key('PageDown');
    expect(app.cursor()).toEqual([18, 0]);
    app.key('End');
    expect(app.cursor()).toEqual([63, 0]);
    app.key('PageUp');
    app.key('ArrowUp');
    expect(app.cursor()).toEqual([46, 0]);
    app.key('Home');
    app.key('Tab');
    expect(app.cursor()).toEqual([0, 1]);
    app.key('Tab', { shiftKey: true });
    app.key('F11');
    expect(app.cursor()).toEqual([32, 0]);
    app.key('KeyR', { altKey: true });
    expect(app.cursor()).toEqual([32, 3]);
    // Alt+I is channel 8, which this song does not have.
    app.key('KeyI', { altKey: true });
    expect(app.cursor()).toEqual([32, 3]);
    app.key('ArrowRight');
    app.key('ArrowLeft');
    app.key('ArrowLeft');
    expect(app.cursor()).toEqual([32, 2]);
    app.key('ArrowRight', { shiftKey: true });
    expect(app.$('#pattern .c.sel')).toBeTruthy();
    app.key('ArrowLeft', { shiftKey: true });
    app.key('F12', { shiftKey: true });
    expect(app.cursor()).toEqual([48, 2]);
  });

  it('writes key-offs, values in every column, and clears them', async () => {
    app = await bootApp();
    app.key('Space');
    // Every entry steps down a row, so each one goes back up first.
    app.key('Digit1');
    expect(app.cell(0, 0)).toContain('==');
    app.key('ArrowUp');
    app.key('ArrowRight');
    app.key('ArrowRight');
    app.key('Digit2');
    app.key('ArrowUp');
    app.key('ArrowRight');
    app.key('Digit3');
    app.key('ArrowUp');
    app.key('ArrowRight');
    app.key('ArrowRight');
    app.key('KeyC');
    app.key('ArrowUp');
    app.key('ArrowRight');
    app.key('Digit2');
    // A key the column does not take changes nothing.
    app.key('ArrowUp');
    app.key('KeyZ');
    expect(app.cursor()).toEqual([0, 0]);
    const cell = saved(0, 0);
    // The volume column stores volume 30 as 0x40.
    expect(cell).toMatchObject({ note: NOTE_KEY_OFF, instrument: 2, volume: 0x40, effect: 0xc, param: 0x20 });
    app.key('Delete');
    app.key('ArrowUp');
    for (let i = 0; i < 3; i++) app.key('ArrowLeft');
    app.key('Delete');
    app.key('ArrowUp');
    for (let i = 0; i < 2; i++) app.key('ArrowLeft');
    app.key('Delete');
    app.key('ArrowUp');
    app.key('ArrowLeft');
    app.key('Delete');
    expect(app.cell(0, 0)).toBe(EMPTY);
  });

  it('inserts and deletes rows in a channel or across all', async () => {
    app = await bootApp();
    app.key('Space');
    app.key('KeyQ');
    app.key('Home');
    app.key('Insert');
    expect(app.cell(1, 0)).toContain('C-5');
    app.key('Insert', { shiftKey: true });
    expect(app.cell(2, 0)).toContain('C-5');
    app.key('ArrowDown');
    app.key('Backspace');
    expect(app.cell(1, 0)).toContain('C-5');
    app.key('Home');
    app.key('Backspace');
    app.key('ArrowDown');
    app.key('Backspace', { shiftKey: true });
    expect(app.cell(0, 0)).toContain('C-5');
  });

  it('changes the octave with F-keys, the numpad and Ctrl+arrows', async () => {
    app = await bootApp();
    app.key('F2');
    expect(app.$('#octave').textContent).toBe('02');
    app.key('NumpadMultiply');
    expect(app.$('#octave').textContent).toBe('03');
    app.key('ArrowUp', { ctrlKey: true });
    expect(app.$('#octave').textContent).toBe('04');
    app.key('ArrowDown', { ctrlKey: true });
    app.key('NumpadDivide');
    expect(app.$('#octave').textContent).toBe('02');
  });

  it('cuts, copies and pastes blocks, tracks and patterns with the FT2 keys', async () => {
    app = await bootApp();
    app.key('Space');
    app.key('KeyQ');
    app.key('KeyW');
    app.key('Home');
    app.key('F4', { shiftKey: true });
    expect(app.status()).toBe('Copied track: 64 rows × 1 channels.');
    app.key('Tab');
    app.key('F5', { shiftKey: true });
    expect(app.cell(1, 1)).toContain('D-5');
    app.key('F3', { ctrlKey: true });
    expect(app.status()).toBe('Cut pattern: 64 rows × 4 channels.');
    expect(app.cell(0, 0)).toBe(EMPTY);
    app.key('F5', { ctrlKey: true });
    expect(app.cell(0, 1)).toContain('C-5');
    app.key('ArrowDown', { shiftKey: true });
    app.key('F4', { altKey: true });
    expect(app.status()).toBe('Copied block: 2 rows × 1 channels.');
    app.key('ArrowDown');
    app.key('ArrowDown');
    app.key('F5', { altKey: true });
    expect(app.cell(3, 1)).toContain('C-5');
    expect(app.cell(4, 1)).toContain('D-5');
    app.key('F3', { shiftKey: true });
    expect(app.status()).toBe('Cut track: 64 rows × 1 channels.');
    // A function key without a modifier sets the octave instead.
    app.key('F3');
    expect(app.$('#octave').textContent).toBe('03');
  });

  it('pastes nothing before something was copied', async () => {
    app = await bootApp();
    app.key('Space');
    app.key('F5', { shiftKey: true });
    app.key('KeyV', { ctrlKey: true });
    expect(app.cell(0, 0)).toBe(EMPTY);
  });

  it('copies, cuts, pastes, selects all and transposes with Ctrl and Alt', async () => {
    app = await bootApp();
    app.key('Space');
    app.key('KeyQ');
    app.key('Home');
    app.key('KeyC', { ctrlKey: true });
    expect(app.status()).toBe('Copied 1 rows × 1 channels.');
    app.key('ArrowDown');
    app.key('KeyV', { ctrlKey: true });
    expect(app.cell(1, 0)).toContain('C-5');
    app.key('KeyX', { ctrlKey: true });
    expect(app.status()).toBe('Cut 1 rows × 1 channels.');
    app.key('KeyV', { ctrlKey: true, shiftKey: true });
    app.key('Escape');
    app.key('Home');
    app.key('ArrowUp', { altKey: true });
    expect(app.cell(0, 0)).toContain('C#5');
    app.key('ArrowDown', { altKey: true, shiftKey: true });
    expect(app.cell(0, 0)).toContain('C#4');
    app.key('KeyA', { ctrlKey: true });
    app.key('ArrowUp', { altKey: true });
    expect(app.cell(0, 0)).toContain('D-4');
  });

  it('interpolates volumes and effects across a selection', async () => {
    app = await bootApp();
    app.key('Space');
    app.key('KeyI', { ctrlKey: true });
    expect(app.status()).toBe('Select at least three rows to interpolate.');
    for (let i = 0; i < 3; i++) app.key('ArrowRight');
    app.key('Digit1');
    app.key('F10');
    app.key('Digit4');
    app.key('Home');
    for (let i = 0; i < 16; i++) app.key('ArrowDown', { shiftKey: true });
    app.key('KeyI', { ctrlKey: true });
    expect(app.status()).toBe('Interpolated 15 volumes.');
    expect(saved(8, 0).volume).toBe(0x38);
    app.key('ArrowRight');
    app.key('ArrowRight');
    app.key('KeyI', { ctrlKey: true });
    expect(app.status()).toBe('Nothing to interpolate: the first and last row need the same kind of effect.');
    app.key('ArrowLeft');
    app.key('ArrowLeft');
    app.key('Escape');
    app.key('F12');
    for (let i = 0; i < 4; i++) app.key('ArrowDown', { shiftKey: true });
    app.key('KeyI', { ctrlKey: true });
    expect(app.status()).toBe('Nothing to interpolate: the first and last row need the same kind of volume command.');
  });

  it('mutes the cursor channel with Shift+M and unmutes all with Shift+U', async () => {
    app = await bootApp();
    app.key('Tab');
    app.key('KeyM', { shiftKey: true });
    expect(app.status()).toBe('Muted: 2');
    expect(app.$('#scopes').children[1]!.classList.contains('muted')).toBe(true);
    app.key('KeyU', { shiftKey: true });
    expect(app.status()).toBe('All channels on.');
  });

  it('toggles following the song with Ctrl+F', async () => {
    app = await bootApp();
    app.key('KeyF', { ctrlKey: true });
    expect(app.status()).toBe('Follow song off: the cursor stays put while the song plays.');
    app.key('KeyF', { ctrlKey: true });
    expect(app.status()).toBe('Follow song on.');
  });

  it('ignores keys while a dialog or a text field has them', async () => {
    app = await bootApp();
    app.click('#help-open');
    app.key('Space');
    expect(app.$('#rec').getAttribute('aria-pressed')).toBe('false');
    app.dialog()!.close();
    app.$<HTMLInputElement>('#title').focus();
    app.key('Space');
    expect(app.$('#rec').getAttribute('aria-pressed')).toBe('false');
  });

  it('only plays notes outside the pattern view, and takes the commands that apply there', async () => {
    app = await bootApp();
    app.click('[data-view-target="sample"]');
    app.key('Space');
    expect(app.$('#rec').getAttribute('aria-pressed')).toBe('false');
    app.key('F4');
    expect(app.$('#octave').textContent).toBe('04');
    app.key('KeyQ');
    await app.settle();
    expect(app.status()).toBe('C-5  Instr 01');
    app.key('KeyQ', { altKey: true });
    app.key('KeyQ', { repeat: true });
    app.key('KeyC', { ctrlKey: true });
    expect(app.status()).toBe('C-5  Instr 01');
    app.key('KeyZ', { ctrlKey: true });
    expect(app.status()).toBe('Nothing to undo.');
    app.key('Enter');
    await app.settle();
    expect(app.messages.at(-1)).toMatchObject({ type: 'play', loopPattern: false });
    app.key('Space');
    expect(app.messages.at(-1)).toEqual({ type: 'stop' });
    app.key('Digit5');
  });
});

describe('touch entry', () => {
  it('shows the cursor cell in big fields and fills values from the keypad', async () => {
    app = await bootApp();
    app.click('#keys-toggle');
    expect(app.$('#keys-toggle').getAttribute('aria-pressed')).toBe('true');
    app.click('#rec');
    expect(app.$('#app').classList.contains('touch-entry')).toBe(true);
    const field = (i: number) => app.$(`#entry-pad [data-field="${[0, 2, 4, 5, 7][i]}"] span`).textContent;
    expect(field(0)).toBe('---');
    app.click('#entry-pad [data-pad="off"]');
    app.click('#entry-pad [data-pad="up"]');
    expect(field(0)).toBe('===');
    app.click('#entry-pad [data-pad="clear"]');
    app.click('#entry-pad [data-pad="up"]');
    expect(field(0)).toBe('---');
    app.click('#entry-pad [data-pad="undo"]');
    app.click('#entry-pad [data-pad="undo"]');
    app.click('#entry-pad [data-pad="undo"]');
    expect(app.status()).toBe('Nothing to undo.');
    app.click('#entry-pad [data-field="1"]');
    expect(app.$('#app').classList.contains('value-entry')).toBe(true);
    app.click('#entry-keys [data-key="3"]');
    app.click('#entry-keys [data-key="2"]');
    expect(saved(0, 0).instrument).toBe(0x32);
    app.click('#entry-pad [data-pad="right"]');
    app.click('#entry-pad [data-pad="down"]');
    app.click('#entry-pad [data-pad="left"]');
    expect(app.cursor()).toEqual([2, 0]);
  });
});
