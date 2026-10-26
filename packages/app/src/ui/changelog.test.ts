import { describe, expect, it } from 'vitest';
import { CHANGELOG } from './changelog-content.ts';
import { hasVisitedBefore, isNew, latestRelease, shouldShow } from './changelog.ts';

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
