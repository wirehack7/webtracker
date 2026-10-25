import { CELL_SIZE, emptyInstrument, emptyPattern, ensurePattern, MAX_ORDERS, MAX_PATTERNS, setChannelCount, type Instrument, type Pattern, type Sample, type Song } from '@webtracker/engine';
import type { EngineMessage } from '../audio/messages.ts';
import { History } from './history.ts';

const clonePattern = (p: Pattern): Pattern => ({ rows: p.rows, data: p.data.slice() });

export const MAX_INSTRUMENTS = 128;

const cloneSample = (s: Sample): Sample => ({ ...s, data: s.data.slice() });

export function cloneInstrument(ins: Instrument): Instrument {
  const env = (e: Instrument['volumeEnvelope']) => ({ ...e, points: e.points.map((p) => ({ ...p })) });
  return {
    ...ins,
    samples: ins.samples.map(cloneSample),
    keymap: ins.keymap.slice(),
    volumeEnvelope: env(ins.volumeEnvelope),
    panningEnvelope: env(ins.panningEnvelope),
  };
}

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameInstrument(a: Instrument, b: Instrument): boolean {
  const { samples: sa, keymap: ka, ...ra } = a;
  const { samples: sb, keymap: kb, ...rb } = b;
  if (JSON.stringify(ra) !== JSON.stringify(rb) || !sameArray(ka, kb) || sa.length !== sb.length) return false;
  return sa.every((s, i) => {
    const t = sb[i]!;
    const { data: da, ...xa } = s;
    const { data: db, ...xb } = t;
    return JSON.stringify(xa) === JSON.stringify(xb) && sameArray(da, db);
  });
}

function samePattern(a: Pattern, b: Pattern): boolean {
  if (a.rows !== b.rows || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/**
 * The cells that one pattern edit changed, so undo and redo touch only
 * those and leave the rest of the pattern (for example a jam partner's
 * edits made since) alone. Null when the pattern changed size.
 */
interface PatternPatch {
  cells: number[];
  before: Uint8Array;
  after: Uint8Array;
}

function patternPatch(before: Pattern, after: Pattern): PatternPatch | null {
  if (before.rows !== after.rows || before.data.length !== after.data.length) return null;
  const cells: number[] = [];
  for (let o = 0; o < before.data.length; o += CELL_SIZE) {
    for (let b = 0; b < CELL_SIZE; b++) {
      if (before.data[o + b] !== after.data[o + b]) {
        cells.push(o / CELL_SIZE);
        break;
      }
    }
  }
  const pick = (p: Pattern) => {
    const out = new Uint8Array(cells.length * CELL_SIZE);
    cells.forEach((c, i) => out.set(p.data.subarray(c * CELL_SIZE, (c + 1) * CELL_SIZE), i * CELL_SIZE));
    return out;
  };
  return { cells, before: pick(before), after: pick(after) };
}

function applyPatch(pattern: Pattern, patch: PatternPatch, side: 'before' | 'after'): void {
  const bytes = patch[side];
  patch.cells.forEach((c, i) => {
    // Another edit may have shortened the pattern since.
    if ((c + 1) * CELL_SIZE <= pattern.data.length) pattern.data.set(bytes.subarray(i * CELL_SIZE, (i + 1) * CELL_SIZE), c * CELL_SIZE);
  });
}

/** What a change touched, for passing local edits on to a jam session and remote ones to the player. */
export type SongEdit =
  | { kind: 'pattern'; index: number }
  | { kind: 'instrument'; index: number }
  | { kind: 'orders' }
  | { kind: 'tempo' }
  | { kind: 'title' }
  /** Channel count or a song-wide tool: the whole song. */
  | { kind: 'song' };

/** A song with its own undo history, parked while another tab is in the editor. */
export interface SongDocument {
  song: Song;
  history: History;
  dirty: boolean;
}

/**
 * Owns the song being edited. Every change goes through here so it lands in
 * the undo history and reaches the copy of the song playing in the worklet.
 */
export class SongEditor {
  history = new History();
  /** True once the song differs from what was loaded or last saved. */
  dirty = false;
  /** Called after every change, undo and redo, so the UI can redraw. */
  onChange: ((label: string) => void) | null = null;
  /** Called for every change made here (not for `applyRemote`), for sharing it in a jam. */
  onEdit: ((edit: SongEdit) => void) | null = null;
  private remote = false;

  constructor(
    public song: Song,
    private readonly sync: (message: EngineMessage) => void,
  ) {}

  /** Starts over with another song; history does not carry across. */
  replaceSong(song: Song): void {
    this.song = song;
    // A new history, so a parked tab keeps its own.
    this.history = new History();
    this.dirty = false;
    this.sync({ type: 'load', song });
  }

  /** The song, its history and dirty flag, for parking it in a tab. */
  detach(): SongDocument {
    return { song: this.song, history: this.history, dirty: this.dirty };
  }

  /** Brings back a parked song with its undo history. */
  attach(doc: SongDocument): void {
    this.song = doc.song;
    this.history = doc.history;
    this.dirty = doc.dirty;
    this.sync({ type: 'load', song: doc.song });
  }

  private edited(edit: SongEdit): void {
    if (!this.remote) this.onEdit?.(edit);
  }

  private sendPattern(index: number): void {
    const pattern = this.song.patterns[index];
    if (pattern) this.sync({ type: 'pattern', index, pattern });
    this.edited({ kind: 'pattern', index });
  }

  private sendOrders(): void {
    const { orders, restartPosition } = this.song;
    this.sync({ type: 'orders', orders: [...orders], restartPosition });
    this.edited({ kind: 'orders' });
  }

  private sendTempo(): void {
    this.sync({ type: 'tempo', speed: this.song.initialSpeed, tempo: this.song.initialTempo });
    this.edited({ kind: 'tempo' });
  }

  private sendSong(): void {
    this.sync({ type: 'load', song: this.song });
    this.edited({ kind: 'song' });
  }

  /**
   * Passes on changes someone else made to the song (already applied to
   * it) to the player and the UI. They stay out of the undo history; a
   * whole new song clears it, as the steps in it no longer fit.
   */
  applyRemote(edits: SongEdit[], label: string): void {
    this.remote = true;
    try {
      for (const edit of edits) {
        if (edit.kind === 'pattern') this.sendPattern(edit.index);
        else if (edit.kind === 'instrument') this.sendInstrument(edit.index);
        else if (edit.kind === 'orders') this.sendOrders();
        else if (edit.kind === 'tempo') this.sendTempo();
        else if (edit.kind === 'song') {
          this.sendSong();
          this.history.clear();
        }
      }
    } finally {
      this.remote = false;
    }
    this.changed(label);
  }

  private changed(label: string): void {
    this.dirty = true;
    this.onChange?.(label);
  }

  /**
   * Runs `edit` on pattern `index` (in place, or by returning a replacement)
   * and records it. Edits that change nothing are not recorded.
   */
  editPattern(index: number, label: string, edit: (pattern: Pattern) => Pattern | void): void {
    const current = ensurePattern(this.song, index);
    const before = clonePattern(current);
    const replacement = edit(current);
    // Only a returned pattern replaces it; edits written as one-line arrows may return other values.
    if (replacement && typeof replacement === 'object' && 'data' in replacement) this.song.patterns[index] = replacement;
    const after = clonePattern(this.song.patterns[index]!);
    if (samePattern(before, after)) return;

    const patch = patternPatch(before, after);
    const apply = (side: 'before' | 'after') => {
      if (patch) applyPatch(ensurePattern(this.song, index), patch, side);
      else this.song.patterns[index] = clonePattern(side === 'before' ? before : after);
      this.sendPattern(index);
      this.changed(label);
    };
    this.history.push({ label, undo: () => apply('before'), redo: () => apply('after') });
    this.sendPattern(index);
    this.changed(label);
  }

  /** Edits several patterns in place as one undo step, e.g. a song-wide transpose. */
  editPatterns(indices: number[], label: string, edit: (pattern: Pattern) => void): void {
    const changes: { index: number; patch: PatternPatch }[] = [];
    for (const index of new Set(indices)) {
      const current = ensurePattern(this.song, index);
      const before = clonePattern(current);
      edit(current);
      // In-place edits keep the size, so there is always a patch.
      const patch = patternPatch(before, current);
      if (patch?.cells.length) changes.push({ index, patch });
    }
    if (!changes.length) return;
    const apply = (side: 'before' | 'after') => {
      for (const change of changes) {
        applyPatch(ensurePattern(this.song, change.index), change.patch, side);
        this.sendPattern(change.index);
      }
      this.changed(label);
    };
    this.history.push({ label, undo: () => apply('before'), redo: () => apply('after') });
    for (const change of changes) this.sendPattern(change.index);
    this.changed(label);
  }

  /** The instrument at 0-based `index`, adding empty instruments up to it. */
  instrument(index: number): Instrument {
    const list = this.song.instruments;
    while (list.length <= index && list.length < MAX_INSTRUMENTS) list.push(emptyInstrument());
    return list[index]!;
  }

  private sendInstrument(index: number): void {
    const instrument = this.song.instruments[index];
    if (instrument) this.sync({ type: 'instrument', index, instrument });
    this.edited({ kind: 'instrument', index });
  }

  /** Runs `edit` on instrument `index` (0-based), in place, and records it. */
  editInstrument(index: number, label: string, edit: (instrument: Instrument) => unknown): void {
    const before = cloneInstrument(this.instrument(index));
    edit(this.song.instruments[index]!);
    this.recordInstrument(index, label, before);
  }

  /** Puts a whole new instrument at `index`, for example one loaded from an XI file. */
  replaceInstrument(index: number, label: string, instrument: Instrument): void {
    const before = cloneInstrument(this.instrument(index));
    this.song.instruments[index] = instrument;
    this.recordInstrument(index, label, before);
  }

  /**
   * Sends the instrument to the player without recording, for changes made
   * while dragging. `recordInstrument` with the state from before the drag
   * then makes the whole drag one undo step.
   */
  previewInstrument(index: number): void {
    this.sendInstrument(index);
  }

  snapshotInstrument(index: number): Instrument {
    return cloneInstrument(this.instrument(index));
  }

  recordInstrument(index: number, label: string, before: Instrument): void {
    const after = cloneInstrument(this.song.instruments[index]!);
    if (sameInstrument(before, after)) return;
    const apply = (ins: Instrument) => {
      this.song.instruments[index] = cloneInstrument(ins);
      this.sendInstrument(index);
      this.changed(label);
    };
    this.history.push({ label, undo: () => apply(before), redo: () => apply(after) });
    this.sendInstrument(index);
    this.changed(label);
  }

  /** Changes the order list. Patterns it points to are created when missing. */
  editOrders(label: string, edit: (orders: number[]) => number[]): void {
    const before = [...this.song.orders];
    const after = edit([...before])
      .slice(0, MAX_ORDERS)
      .map((p) => Math.max(0, Math.min(MAX_PATTERNS - 1, p)));
    if (after.length === 0 || after.join() === before.join()) return;

    const apply = (orders: number[]) => {
      const known = this.song.patterns.length;
      this.song.orders = [...orders];
      for (const p of orders) ensurePattern(this.song, p);
      for (let p = known; p < this.song.patterns.length; p++) this.sendPattern(p);
      if (this.song.restartPosition >= orders.length) this.song.restartPosition = 0;
      this.sendOrders();
      this.changed(label);
    };
    this.history.push({ label, undo: () => apply(before), redo: () => apply(after) });
    apply(after);
  }

  /**
   * Fills pattern `index` with a copy of `pattern` and plays it at order
   * position `at`, as one undo step: a new or cloned pattern from the picker.
   */
  placePattern(at: number, index: number, pattern: Pattern, label: string): void {
    if (index < 0 || index >= MAX_PATTERNS || at < 0 || at >= this.song.orders.length) return;
    const beforeOrders = [...this.song.orders];
    const afterOrders = beforeOrders.map((p, i) => (i === at ? index : p));
    const existing = this.song.patterns[index];
    const beforePattern = existing ? clonePattern(existing) : emptyPattern(64, this.song.channels);
    const afterPattern = clonePattern(pattern);
    const apply = (orders: number[], content: Pattern) => {
      const known = this.song.patterns.length;
      ensurePattern(this.song, index);
      this.song.patterns[index] = clonePattern(content);
      for (let p = known; p < index; p++) this.sendPattern(p);
      this.sendPattern(index);
      this.song.orders = [...orders];
      this.sendOrders();
      this.changed(label);
    };
    this.history.push({ label, undo: () => apply(beforeOrders, beforePattern), redo: () => apply(afterOrders, afterPattern) });
    apply(afterOrders, afterPattern);
  }

  /** Initial speed and BPM; FT2 does not undo these, so neither do we. */
  setTempo(speed: number, tempo: number): void {
    if (speed === this.song.initialSpeed && tempo === this.song.initialTempo) return;
    this.song.initialSpeed = speed;
    this.song.initialTempo = tempo;
    this.sendTempo();
    this.changed('tempo');
  }

  /** Song title, at most 20 characters as in XM. */
  setTitle(title: string): void {
    const after = title.slice(0, 20);
    const before = this.song.title;
    if (after === before) return;
    const apply = (t: string) => {
      this.song.title = t;
      this.edited({ kind: 'title' });
      this.changed('title');
    };
    this.history.push({ label: 'title', undo: () => apply(before), redo: () => apply(after) });
    apply(after);
  }

  /**
   * Changes the channel count of every pattern. The player is rebuilt for
   * the new layout, so playback stops.
   */
  setChannels(channels: number): void {
    const song = this.song;
    const snapshot = () => ({ channels: song.channels, panning: [...song.channelPanning], patterns: song.patterns.map(clonePattern) });
    const before = snapshot();
    setChannelCount(song, channels);
    if (song.channels === before.channels) return;
    const after = snapshot();
    const apply = (state: typeof before) => {
      song.channels = state.channels;
      song.channelPanning = [...state.panning];
      song.patterns = state.patterns.map(clonePattern);
      this.sendSong();
      this.changed('channels');
    };
    this.history.push({ label: 'channels', undo: () => apply(before), redo: () => apply(after) });
    this.sendSong();
    this.changed('channels');
  }

  /**
   * Changes patterns, orders and instruments together as one undo step, for
   * song-wide tools such as the cleanup. The player is rebuilt, so playback stops.
   */
  editSong(label: string, edit: (song: Song) => void): void {
    const song = this.song;
    const snapshot = () => ({ orders: [...song.orders], patterns: song.patterns.map(clonePattern), instruments: song.instruments.map(cloneInstrument) });
    const before = snapshot();
    edit(song);
    const after = snapshot();
    const apply = (state: typeof before) => {
      song.orders = [...state.orders];
      song.patterns = state.patterns.map(clonePattern);
      song.instruments = state.instruments.map(cloneInstrument);
      if (song.restartPosition >= song.orders.length) song.restartPosition = 0;
      this.sendSong();
      this.changed(label);
    };
    this.history.push({ label, undo: () => apply(before), redo: () => apply(after) });
    this.sendSong();
    this.changed(label);
  }

  undo(): string | null {
    return this.history.undo()?.label ?? null;
  }

  redo(): string | null {
    return this.history.redo()?.label ?? null;
  }
}
