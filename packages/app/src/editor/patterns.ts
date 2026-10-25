import { MAX_PATTERNS, type Pattern, type Song } from '@webtracker/engine';

/** What the pattern picker shows for one pattern. */
export interface PatternInfo {
  index: number;
  rows: number;
  /** Order positions that play this pattern. */
  positions: number[];
  /** True when every cell is blank. */
  empty: boolean;
}

export function isBlankPattern(pattern: Pattern | undefined): boolean {
  return !pattern || pattern.data.every((b) => b === 0);
}

export function patternInfos(song: Song): PatternInfo[] {
  const positions = song.patterns.map((): number[] => []);
  song.orders.forEach((p, at) => positions[p]?.push(at));
  return song.patterns.map((pattern, index) => ({ index, rows: pattern.rows, positions: positions[index] ?? [], empty: isBlankPattern(pattern) }));
}

/**
 * The pattern a new or cloned pattern goes into: the first one that no
 * position plays and that holds nothing, else one past the end. Null when
 * all pattern slots are taken.
 */
export function freePattern(song: Song): number | null {
  const used = new Set(song.orders);
  for (let i = 0; i < song.patterns.length; i++) {
    if (!used.has(i) && isBlankPattern(song.patterns[i])) return i;
  }
  return song.patterns.length < MAX_PATTERNS ? song.patterns.length : null;
}
