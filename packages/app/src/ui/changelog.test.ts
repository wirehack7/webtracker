// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPage } from '../test-dom.ts';
import { CHANGELOG } from './changelog-content.ts';
import { hasVisitedBefore, isNew, latestRelease, markSeen, mountWhatsNew, readSeen, SEEN_KEY, shouldShow } from './changelog.ts';

function storage(keys: string[]): Storage {
  return { length: keys.length, key: (i: number) => keys[i] ?? null } as Storage;
}

describe("What's new", () => {
  it('lists releases newest first with unique dated ids', () => {
    const ids = CHANGELOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{4}-\d{2}-\d{2}[a-z]?$/);
    expect([...ids].sort().reverse()).toEqual(ids);
    for (const release of CHANGELOG) expect(release.items.length).toBeGreaterThan(0);
  });

  it('opens once for returning visitors, never on a first visit', () => {
    expect(shouldShow(null, false)).toBe(false);
    expect(shouldShow(null, true)).toBe(true);
    expect(shouldShow('2000-01-01', true)).toBe(true);
    expect(shouldShow(latestRelease(), true)).toBe(false);
  });

  it('marks the releases since the last one seen as new', () => {
    const [latest, older] = CHANGELOG;
    expect(isNew(latest!, older!.id)).toBe(true);
    expect(isNew(older!, older!.id)).toBe(false);
    expect(isNew(latest!, null)).toBe(true);
    expect(isNew(older!, null)).toBe(false);
  });

  it('tells a return from a first visit by the keys the tracker keeps', () => {
    expect(hasVisitedBefore(storage([]))).toBe(false);
    expect(hasVisitedBefore(storage(['other.site']))).toBe(false);
    expect(hasVisitedBefore(storage(['other.site', 'webtracker.settings']))).toBe(true);
  });
});

describe("What's new dialog", () => {
  const stored = new Map<string, string>();
  const stubStorage = (throws = false) =>
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => {
        if (throws) throw new Error('off');
        return stored.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (throws) throw new Error('off');
        stored.set(k, v);
      },
    });

  afterEach(() => {
    stored.clear();
    vi.unstubAllGlobals();
  });

  it('lists every release with dates, marks the new ones, and remembers it was seen on close', async () => {
    stubStorage();
    await loadPage('index.html', '#whats-new');
    const dialog = document.querySelector<HTMLDialogElement>('#whats-new')!;
    const whatsNew = mountWhatsNew(dialog);
    stored.set(SEEN_KEY, CHANGELOG[1]!.id);
    whatsNew.open();
    expect(dialog.open).toBe(true);
    const heads = [...dialog.querySelectorAll('h3')];
    expect(heads).toHaveLength(CHANGELOG.length);
    expect(heads[0]!.textContent).toMatch(/\d{4}/);
    expect(heads.filter((h) => h.querySelector('.whats-new-badge')).length).toBe(1);
    expect(dialog.querySelectorAll('.whats-new-list')[0]!.children).toHaveLength(CHANGELOG[0]!.items.length);
    whatsNew.open();
    dialog.close();
    expect(readSeen()).toBe(latestRelease());
  });

  it('shows an id that is no date as it is', async () => {
    stubStorage();
    await loadPage('index.html', '#whats-new');
    const release = { id: 'not-a-date', items: ['x'] };
    CHANGELOG.push(release);
    try {
      mountWhatsNew(document.querySelector<HTMLDialogElement>('#whats-new')!).open();
      expect([...document.querySelectorAll('h3')].at(-1)!.textContent).toBe('not-a-date');
    } finally {
      CHANGELOG.pop();
    }
  });

  it('works without storage', () => {
    stubStorage(true);
    expect(readSeen()).toBeNull();
    expect(() => markSeen()).not.toThrow();
  });
});
