// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { track, TRACK_EVENT } from './track.ts';

describe('track', () => {
  it('announces an action on window, with data only when given', () => {
    const seen: unknown[] = [];
    addEventListener(TRACK_EVENT, (e) => seen.push((e as CustomEvent).detail));
    track('export', { format: 'wav', seconds: 3 });
    track('play');
    expect(seen).toEqual([{ name: 'export', data: { format: 'wav', seconds: 3 } }, { name: 'play' }]);
  });
});
