import { describe, expect, it } from 'vitest';
import { installState } from './pwa.ts';

describe('installState', () => {
  it('reports an installed app first', () => {
    expect(installState(true, true, true)).toBe('installed');
  });
  it("offers the browser's prompt when there is one", () => {
    expect(installState(false, true, false)).toBe('prompt');
  });
  it('points iPhone and iPad to the share sheet', () => {
    expect(installState(false, false, true)).toBe('ios');
  });
  it('has nothing to offer elsewhere', () => {
    expect(installState(false, false, false)).toBe('none');
  });
});
