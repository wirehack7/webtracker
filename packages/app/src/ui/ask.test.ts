// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { ask, askText, tell } from './ask.ts';

/** The in-page confirm() and prompt(), driven the way a user would. */

const dialog = () => document.querySelector('dialog')!;
const buttons = () => [...dialog().querySelectorAll('button')];
const press = (label: string) => buttons().find((b) => b.textContent === label)!.click();

afterEach(() => document.body.replaceChildren());

describe('ask', () => {
  it('shows the question with a title and resolves true on OK', async () => {
    const answer = ask('Delete this song?', { ok: 'Delete', title: 'Library' });
    expect(dialog().open).toBe(true);
    expect(dialog().getAttribute('aria-label')).toBe('Library');
    expect(dialog().querySelector('h2')!.textContent).toBe('Library');
    const describedBy = dialog().getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)!.textContent).toBe('Delete this song?');
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Delete']);
    expect(document.activeElement?.textContent).toBe('Delete');
    press('Delete');
    expect(await answer).toBe(true);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('resolves false on Cancel and on a click beside the dialog', async () => {
    const first = ask('Sure?');
    expect(dialog().getAttribute('aria-label')).toBe('Question');
    press('Cancel');
    expect(await first).toBe(false);

    const second = ask('Sure?');
    const d = dialog();
    d.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 }) as DOMRect;
    // A click inside the dialog's box, on its padding, does not close it.
    d.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50, bubbles: true }));
    expect(d.open).toBe(true);
    d.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 50, bubbles: true }));
    expect(await second).toBe(false);
  });

  it('keeps keys from reaching the editor underneath', async () => {
    let reached = false;
    document.addEventListener('keydown', () => (reached = true));
    const answer = ask('Sure?');
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(reached).toBe(false);
    press('OK');
    await answer;
  });
});

describe('tell', () => {
  it('shows a message with only OK', async () => {
    const done = tell('That file is not a module.');
    expect(buttons().map((b) => b.textContent)).toEqual(['OK']);
    press('OK');
    await done;
    const titled = tell('Saved.', 'Export');
    expect(dialog().querySelector('h2')!.textContent).toBe('Export');
    press('OK');
    await titled;
  });
});

describe('askText', () => {
  it('starts with the value selected and resolves with what was typed', async () => {
    const answer = askText('Song name', 'old', { inputMode: 'numeric' });
    const field = dialog().querySelector('input')!;
    expect(field.value).toBe('old');
    expect(field.inputMode).toBe('numeric');
    expect(field.getAttribute('aria-label')).toBe('Song name');
    expect(document.activeElement).toBe(field);
    field.value = 'new';
    press('OK');
    expect(await answer).toBe('new');
  });

  it('resolves null when cancelled', async () => {
    const answer = askText('Song name');
    press('Cancel');
    expect(await answer).toBeNull();
  });
});
