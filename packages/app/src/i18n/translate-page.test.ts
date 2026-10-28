// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import de from './de.ts';
import { editName } from './edit-names.ts';
import { initLanguage, language, t, tNodes, translatePage, useMessages } from './i18n.ts';

/** Switching languages at run time and translating the HTML pages, in a DOM. */

afterEach(() => {
  useMessages('en', {});
  vi.unstubAllGlobals();
});

describe('initLanguage', () => {
  it('loads the pack for the choice and marks the page', async () => {
    await initLanguage('de');
    expect(language()).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    expect(t('transpose')).toBe('Transponieren');
  });

  it('follows the browser for auto', async () => {
    vi.stubGlobal('navigator', { languages: ['fi-FI', 'en'] });
    await initLanguage('auto');
    expect(language()).toBe('fi');
  });

  it('falls back to the single browser language, then to English', async () => {
    vi.stubGlobal('navigator', { language: 'de-AT' });
    await initLanguage('auto');
    expect(language()).toBe('de');
    vi.stubGlobal('navigator', { languages: ['xx'] });
    await initLanguage('auto');
    expect(language()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('stays in English when the pack cannot load, as offline before it was cached', async () => {
    const { LANGUAGES } = await import('./i18n.ts');
    const load = LANGUAGES.de!.load!;
    LANGUAGES.de!.load = () => Promise.reject(new Error('offline'));
    try {
      await initLanguage('de');
      expect(language()).toBe('en');
    } finally {
      LANGUAGES.de!.load = load;
    }
  });
});

describe('translatePage', () => {
  it('translates text and attributes, keeps the spacing, and skips translate="no", scripts and styles', () => {
    useMessages('de', { 'Play song': 'Song abspielen', Stop: 'Halt', 'Search help': 'Hilfe durchsuchen' });
    document.body.innerHTML = `
      <button title="Play song">
        Play  song
      </button>
      <input placeholder="Search help" aria-label="Unknown">
      <span translate="no">Stop</span>
      <script>Stop</script><style>Stop{}</style>
      <b>Stop</b><i> </i>`;
    translatePage();
    const button = document.querySelector('button')!;
    expect(button.title).toBe('Song abspielen');
    expect(button.textContent).toBe('\n        Song abspielen\n      ');
    expect(document.querySelector('input')!.placeholder).toBe('Hilfe durchsuchen');
    expect(document.querySelector('input')!.getAttribute('aria-label')).toBe('Unknown');
    expect(document.querySelector('span')!.textContent).toBe('Stop');
    expect(document.querySelector('script')!.textContent).toBe('Stop');
    expect(document.querySelector('b')!.textContent).toBe('Halt');
  });

  it('leaves an English page alone', () => {
    document.body.innerHTML = '<b>Stop</b>';
    translatePage();
    expect(document.body.innerHTML).toBe('<b>Stop</b>');
  });

  it('puts nodes into translated sentences', () => {
    useMessages('de', { 'See {link} for more.': 'Mehr unter {link}.' });
    const link = document.createElement('a');
    expect(tNodes('See {link} for more.', { link })).toEqual(['Mehr unter ', link, '.']);
    expect(tNodes('{missing} stays', {})).toEqual(['{missing}', ' stays']);
  });
});

describe('edit names', () => {
  it('shows undo labels in the chosen language and unknown ones as they are', () => {
    useMessages('de', de);
    expect(editName('transpose')).toBe(de['transpose']);
    expect(editName('something new')).toBe('something new');
  });
});
