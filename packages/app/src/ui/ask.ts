// In-page replacements for confirm() and prompt(), in the look of the other dialogs.
// Enter answers yes (or takes the typed value), Escape or a tap beside the dialog cancels.

import { t } from '../i18n/i18n.ts';
import { el } from './widgets.ts';

export interface AskOptions {
  /** Label of the button that goes ahead, e.g. "Delete". */
  ok?: string;
  /** Label of the button that backs out; '' leaves it out, for a plain message. */
  cancel?: string;
  /** A short heading above the message. */
  title?: string;
  /** Keyboard hint for phones when asking for text, e.g. 'numeric'. */
  inputMode?: string;
}

/** Shows a modal dialog and resolves with the button that closed it: 'ok', or '' when cancelled. */
function show(message: string, options: AskOptions, field?: HTMLInputElement): Promise<string> {
  const dialog = el('dialog', 'panel help file-dialog ask-dialog');
  dialog.setAttribute('aria-label', options.title ?? t('Question'));
  const form = el('form');
  form.method = 'dialog';
  if (options.title) form.append(el('h2', 'ptitle', options.title));
  const text = el('p', 'ask-message', message);
  text.id = `ask-${Math.random().toString(36).slice(2)}`;
  dialog.setAttribute('aria-describedby', text.id);
  form.append(text);
  if (field) {
    field.classList.add('value', 'text', 'ask-field');
    field.setAttribute('aria-label', message);
    form.append(field);
  }
  const ok = el('button', 'btn', options.ok ?? t('OK'));
  ok.value = 'ok';
  const cancel = el('button', 'btn', options.cancel ?? t('Cancel'));
  cancel.value = '';
  // Escape and the backdrop go through cancel, so the OK button can stay the default for Enter.
  cancel.type = 'button';
  cancel.addEventListener('click', () => dialog.close(''));
  const row = el('div', 'row ask-buttons');
  if (options.cancel !== '') row.append(cancel);
  row.append(ok);
  form.append(row);
  dialog.append(form);

  dialog.addEventListener('click', (event) => {
    const r = dialog.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (event.target === dialog && !inside) dialog.close('');
  });
  // Keys stay with the dialog instead of reaching the editor underneath.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());

  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue);
    });
    dialog.returnValue = '';
    dialog.showModal();
    if (field) {
      field.focus();
      field.select();
    } else ok.focus();
  });
}

/** Asks a yes or no question; resolves true when the user goes ahead. */
export async function ask(message: string, options: AskOptions = {}): Promise<boolean> {
  return (await show(message, options)) === 'ok';
}

/** Shows a message with only an OK button, e.g. why a file could not be opened. */
export async function tell(message: string, title?: string): Promise<void> {
  await show(message, title === undefined ? { cancel: '' } : { title, cancel: '' });
}

/** Asks for a line of text; resolves with it, or null when cancelled. */
export async function askText(message: string, value = '', options: AskOptions = {}): Promise<string | null> {
  const field = el('input');
  field.type = 'text';
  field.value = value;
  field.spellcheck = false;
  field.autocomplete = 'off';
  if (options.inputMode) field.inputMode = options.inputMode;
  return (await show(message, options, field)) === 'ok' ? field.value : null;
}
