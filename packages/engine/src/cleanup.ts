/**
 * Song cleanup: removes what a song does not play, to make it smaller
 * before saving or sharing. Order positions never change, so pattern jumps
 * and breaks keep their targets.
 */
import { emptyInstrument } from './sample-edit.ts';
import { CELL_SIZE, LoopType, type Pattern, type Song } from './song.ts';

export interface CleanupOptions {
  /** Drop patterns the order list does not reference. */
  unusedPatterns: boolean;
  /** Point identical patterns in the order list at one copy. */
  duplicatePatterns: boolean;
  /** Clear instruments that no pattern uses. */
  unusedInstruments: boolean;
  /** Renumber the remaining instruments so they follow each other from 1. */
  compactInstruments: boolean;
  /** Drop samples of multi-sample instruments that no played note reaches. */
  unusedSamples: boolean;
  /** Cut looped samples after their loop end, which is never heard. */
  sampleTails: boolean;
}

export interface CleanupResult {
  patterns: number;
  instruments: number;
  samples: number;
  /** Sample frames removed by cutting tails and dropping samples. */
  frames: number;
}

function samePattern(a: Pattern, b: Pattern): boolean {
  if (a.rows !== b.rows || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** The patterns that can play: the order list, or every pattern when unused ones stay. */
function playedPatterns(song: Song, ordersOnly: boolean): Pattern[] {
  const indices = [...new Set(song.orders)];
  if (!ordersOnly) for (let p = 0; p < song.patterns.length; p++) if (!indices.includes(p)) indices.push(p);
  return indices.map((p) => song.patterns[p]).filter((p): p is Pattern => !!p);
}

/**
 * Calls `visit` for every note with the instrument it plays, following each
 * channel's last instrument through the song when a note has none.
 */
function forEachNote(song: Song, patterns: Pattern[], visit: (instrument: number, note: number) => void): void {
  const last = new Array<number>(song.channels).fill(0);
  for (const pattern of patterns) {
    for (let row = 0; row < pattern.rows; row++) {
      for (let c = 0; c < song.channels; c++) {
        const d = (row * song.channels + c) * CELL_SIZE;
        const note = pattern.data[d] ?? 0;
        const instrument = pattern.data[d + 1] ?? 0;
        if (instrument) last[c] = instrument;
        if (note >= 1 && note <= 96 && last[c]) visit(last[c]!, note);
      }
    }
  }
}

/** Counts what {@link cleanupSong} would remove, without changing the song. */
export function cleanupPreview(song: Song, options: CleanupOptions): CleanupResult {
  // Only the parts the cleanup changes are copied; sample data is replaced, never written.
  const copy: Song = {
    ...song,
    orders: [...song.orders],
    patterns: song.patterns.map((p) => ({ rows: p.rows, data: p.data.slice() })),
    instruments: song.instruments.map((ins) => ({ ...ins, keymap: ins.keymap.slice(), samples: ins.samples.map((s) => ({ ...s })) })),
  };
  return cleanupSong(copy, options);
}

export function cleanupSong(song: Song, options: CleanupOptions): CleanupResult {
  const result: CleanupResult = { patterns: 0, instruments: 0, samples: 0, frames: 0 };

  if (options.duplicatePatterns) {
    song.orders = song.orders.map((p) => {
      const pattern = song.patterns[p];
      if (!pattern) return p;
      const first = song.patterns.findIndex((q) => samePattern(q, pattern));
      return first >= 0 ? first : p;
    });
  }
  if (options.unusedPatterns || options.duplicatePatterns) {
    const isCopy = (i: number) => song.patterns.some((q, j) => j < i && samePattern(q, song.patterns[i]!));
    const keep = options.unusedPatterns
      ? [...new Set(song.orders)].filter((p) => song.patterns[p]).sort((a, b) => a - b)
      : song.patterns.map((_, i) => i).filter((i) => !isCopy(i));
    const map = new Map(keep.map((p, i) => [p, i]));
    result.patterns = song.patterns.length - keep.length;
    song.patterns = keep.map((p) => song.patterns[p]!);
    song.orders = song.orders.map((p) => map.get(p) ?? p);
  }

  const patterns = playedPatterns(song, options.unusedPatterns);
  const usedInstruments = new Set<number>();
  const usedSamples = new Map<number, Set<number>>();
  for (const pattern of patterns) {
    for (let i = 1; i < pattern.data.length; i += CELL_SIZE) if (pattern.data[i]) usedInstruments.add(pattern.data[i]!);
  }
  forEachNote(song, patterns, (instrument, note) => {
    const ins = song.instruments[instrument - 1];
    if (!ins) return;
    let set = usedSamples.get(instrument);
    if (!set) usedSamples.set(instrument, (set = new Set()));
    set.add(ins.keymap[note - 1] ?? 0);
  });

  if (options.unusedSamples && song.format === 'xm') {
    song.instruments.forEach((ins, i) => {
      const used = usedSamples.get(i + 1);
      if (!used || ins.samples.length < 2) return;
      const keep = ins.samples.map((_, s) => s).filter((s) => used.has(s));
      if (keep.length === ins.samples.length) return;
      for (let s = 0; s < ins.samples.length; s++) if (!used.has(s)) result.frames += ins.samples[s]!.data.length;
      result.samples += ins.samples.length - keep.length;
      const map = new Map(keep.map((s, n) => [s, n]));
      ins.samples = keep.map((s) => ins.samples[s]!);
      ins.keymap = ins.keymap.map((s) => map.get(s) ?? 0);
    });
  }

  if (options.unusedInstruments) {
    song.instruments.forEach((ins, i) => {
      if (usedInstruments.has(i + 1) || (ins.samples.length === 0 && !ins.name)) return;
      result.instruments++;
      for (const s of ins.samples) result.frames += s.data.length;
      song.instruments[i] = emptyInstrument();
    });
    while (song.instruments.length && !usedInstruments.has(song.instruments.length) && song.instruments.at(-1)!.samples.every((s) => s.data.length === 0) && !song.instruments.at(-1)!.name) {
      song.instruments.pop();
    }
  }

  if (options.compactInstruments) {
    const order = [...usedInstruments].sort((a, b) => a - b);
    const map = new Map(order.map((n, i) => [n, i + 1]));
    if (order.some((n, i) => n !== i + 1)) {
      // Unused instruments that still hold something follow the used ones.
      const rest = song.instruments.map((_, i) => i + 1).filter((n) => !map.has(n) && (song.instruments[n - 1]!.samples.length > 0 || song.instruments[n - 1]!.name));
      for (const n of rest) map.set(n, map.size + 1);
      const instruments = [...map.keys()].map((n) => song.instruments[n - 1] ?? emptyInstrument());
      for (const pattern of song.patterns) {
        for (let i = 1; i < pattern.data.length; i += CELL_SIZE) if (pattern.data[i]) pattern.data[i] = map.get(pattern.data[i]!) ?? 0;
      }
      song.instruments = instruments;
    }
  }

  if (options.sampleTails) {
    for (const ins of song.instruments) {
      for (const s of ins.samples) {
        if (s.loopType === LoopType.None || s.loopLength <= 0) continue;
        const end = s.loopStart + s.loopLength;
        if (s.data.length <= end) continue;
        result.frames += s.data.length - end;
        s.data = s.data.slice(0, end);
      }
    }
  }
  return result;
}
