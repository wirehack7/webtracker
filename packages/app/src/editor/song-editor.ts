import { emptyInstrument, ensurePattern, MAX_ORDERS, MAX_PATTERNS, setChannelCount, type Instrument, type Pattern, type Sample, type Song } from '@webtracker/engine';
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
 * Owns the song being edited. Every change goes through here so it lands in
 * the undo history and reaches the copy of the song playing in the worklet.
 */
export class SongEditor {
  readonly history = new History();
  /** True once the song differs from what was loaded or last saved. */
  dirty = false;
  /** Called after every change, undo and redo, so the UI can redraw. */
  onChange: ((label: string) => void) | null = null;

  constructor(
    public song: Song,
    private readonly sync: (message: EngineMessage) => void,
  ) {}

  /** Starts over with another song; history does not carry across. */
  replaceSong(song: Song): void {
    this.song = song;
    this.history.clear();
    this.dirty = false;
    this.sync({ type: 'load', song });
  }

  private sendPattern(index: number): void {
    const pattern = this.song.patterns[index];
    if (pattern) this.sync({ type: 'pattern', index, pattern });
  }

  private sendOrders(): void {
    const { orders, restartPosition } = this.song;
    this.sync({ type: 'orders', orders: [...orders], restartPosition });
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

    const apply = (p: Pattern) => {
      this.song.patterns[index] = clonePattern(p);
      this.sendPattern(index);
      this.changed(label);
    };
    this.history.push({ label, undo: () => apply(before), redo: () => apply(after) });
    this.sendPattern(index);
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

  /** Initial speed and BPM; FT2 does not undo these, so neither do we. */
  setTempo(speed: number, tempo: number): void {
    if (speed === this.song.initialSpeed && tempo === this.song.initialTempo) return;
    this.song.initialSpeed = speed;
    this.song.initialTempo = tempo;
    this.sync({ type: 'tempo', speed, tempo });
    this.changed('tempo');
  }

  /** Song title, at most 20 characters as in XM. */
  setTitle(title: string): void {
    const after = title.slice(0, 20);
    const before = this.song.title;
    if (after === before) return;
    const apply = (t: string) => {
      this.song.title = t;
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
      this.sync({ type: 'load', song });
      this.changed('channels');
    };
    this.history.push({ label: 'channels', undo: () => apply(before), redo: () => apply(after) });
    this.sync({ type: 'load', song });
    this.changed('channels');
  }

  undo(): string | null {
    return this.history.undo()?.label ?? null;
  }

  redo(): string | null {
    return this.history.redo()?.label ?? null;
  }
}
