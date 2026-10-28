// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPage } from '../test-dom.ts';
import { mountHelp, type Help } from './help.ts';
import { HELP_SECTIONS } from './help-content.ts';

/** The Help dialog in the markup of index.html. */

let help: Help;
let coarse: boolean;
const dialog = () => document.querySelector<HTMLDialogElement>('#help')!;
const search = () => document.querySelector<HTMLInputElement>('.help-search')!;
const visibleSections = () => [...document.querySelectorAll<HTMLElement>('.help-section')].filter((s) => !s.hidden).map((s) => s.dataset.section);
const tab = (id: string) => document.querySelector<HTMLButtonElement>(`[role="tab"][data-section="${id}"]`)!;

beforeEach(async () => {
  coarse = false;
  vi.stubGlobal('matchMedia', () => ({ matches: coarse }));
  Element.prototype.scrollIntoView = vi.fn();
  await loadPage('index.html', '#help');
  help = mountHelp(dialog());
});

afterEach(() => vi.unstubAllGlobals());

describe('Help dialog', () => {
  it('has a tab per topic and opens on the first one, with the search focused', () => {
    expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(HELP_SECTIONS.map((s) => s.title));
    help.open();
    expect(dialog().open).toBe(true);
    expect(visibleSections()).toEqual([HELP_SECTIONS[0]!.id]);
    expect(tab(HELP_SECTIONS[0]!.id).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(search());
  });

  it('switches topics and points the manual link at the topic', () => {
    help.open();
    tab('effects').click();
    expect(visibleSections()).toEqual(['effects']);
    expect(document.querySelector('.help-manual')!.getAttribute('href')).toBe('./manual.html#ref-effects');
    tab('workflow').click();
    expect(document.querySelector('.help-manual')!.getAttribute('href')).toBe('./manual.html#start');
  });

  it('searches all topics and says when nothing is found', () => {
    help.open();
    search().value = 'retrigger';
    search().dispatchEvent(new Event('input'));
    const shown = [...document.querySelectorAll<HTMLElement>('.help-entry')].filter((e) => !e.hidden && !e.closest('[hidden]'));
    expect(shown.length).toBeGreaterThan(0);
    for (const e of shown) expect(e.textContent!.toLowerCase()).toContain('retrigger');
    expect(document.querySelector<HTMLElement>('.help-empty')!.hidden).toBe(true);
    for (const t of document.querySelectorAll('[role="tab"]')) expect(t.getAttribute('aria-selected')).toBe('false');

    search().value = 'qqqzzz';
    search().dispatchEvent(new Event('input'));
    expect(visibleSections()).toEqual([]);
    expect(document.querySelector<HTMLElement>('.help-empty')!.hidden).toBe(false);
  });

  it('jumps to the effect under the cursor, marks it and links the manual there', () => {
    help.open({ id: 'fx-C', shown: 'C20' });
    const context = document.querySelector<HTMLElement>('.help-context')!;
    expect(context.hidden).toBe(false);
    expect(context.textContent).toContain('C20');
    expect(visibleSections()).toEqual(['effects']);
    const entry = document.querySelector('[data-id="fx-C"]')!;
    expect(entry.classList.contains('hit')).toBe(true);
    expect(entry.firstElementChild!.scrollIntoView).toHaveBeenCalled();
    expect(document.querySelector('.help-manual')!.getAttribute('href')).toBe('./manual.html#fx-C');

    // Opening again without a target clears the mark and the context line.
    help.open();
    expect(entry.classList.contains('hit')).toBe(false);
    expect(context.hidden).toBe(true);
  });

  it('leaves the on-screen keyboard closed on touch screens', () => {
    coarse = true;
    help.open();
    expect(document.activeElement).not.toBe(search());
  });
});
