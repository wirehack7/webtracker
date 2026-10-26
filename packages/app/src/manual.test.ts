// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPage } from './test-dom.ts';
import { useMessages } from './i18n/i18n.ts';
import { HELP_SECTIONS } from './ui/help-content.ts';
import { MANUAL_CHAPTERS } from './ui/manual-content.ts';

/** The manual page, built from manual.html and the content modules as a browser would. */

let settings: string;

beforeEach(async () => {
  vi.resetModules();
  settings = JSON.stringify({ language: 'en', theme: 'amber', colors: { '--pat-note': '#123456' } });
  vi.stubGlobal('localStorage', { getItem: () => settings, setItem: () => {} });
  Element.prototype.scrollIntoView = vi.fn();
  await loadPage('manual.html');
});

afterEach(() => {
  useMessages('en', {});
  vi.unstubAllGlobals();
  location.hash = '';
});

describe('manual page', () => {
  it('lists every chapter and reference topic, with the reference after the chapters', async () => {
    await import('./manual.ts');
    const toc = [...document.querySelectorAll('#manual-toc a')].map((a) => a.getAttribute('href'));
    const reference = HELP_SECTIONS.filter((s) => s.id !== 'workflow').map((s) => `#ref-${s.id}`);
    expect(toc).toEqual([...MANUAL_CHAPTERS.map((c) => `#${c.id}`), ...reference]);
    for (const href of toc) expect(document.getElementById(href!.slice(1))).not.toBeNull();
    expect(document.title).toBe('chiptrackr manual');
  });

  it('shows keys as code, links as links, figures linked to their full size, and help entries by id', async () => {
    await import('./manual.ts');
    const body = document.getElementById('manual-body')!;
    expect(body.querySelectorAll('code').length).toBeGreaterThan(10);
    const figure = body.querySelector('figure a')!;
    expect(figure.getAttribute('href')).toMatch(/^\.\/manual\/.+\.png$/);
    expect(figure.querySelector('img')!.getAttribute('alt')!.length).toBeGreaterThan(0);
    expect(body.querySelector('#fx-C .help-code')!.textContent).toBe('Cxx');
    expect(body.querySelectorAll('.manual-tip').length).toBeGreaterThan(0);
    expect(body.querySelectorAll('ol li').length).toBeGreaterThan(0);
  });

  it('takes the theme and colours from the tracker settings', async () => {
    await import('./manual.ts');
    expect(document.documentElement.dataset.theme).toBe('amber');
    expect(document.documentElement.style.getPropertyValue('--pat-note')).toBe('#123456');
  });

  it('opens in the chosen language', async () => {
    settings = JSON.stringify({ language: 'de' });
    await import('./manual.ts');
    expect(document.documentElement.lang).toBe('de');
    expect(document.title).not.toBe('chiptrackr manual');
  });

  it('jumps to the anchor in the address once the content is there', async () => {
    location.hash = '#fx-C';
    await import('./manual.ts');
    expect(document.getElementById('fx-C')!.scrollIntoView).toHaveBeenCalled();
  });
});
