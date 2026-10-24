import { ensurePattern, MAX_ORDERS, MAX_PATTERNS, type Pattern, type Song } from '@webtracker/engine';
import type { EngineMessage } from '../audio/messages.ts';
import { History } from './history.ts';

const clonePattern = (p: Pattern): Pattern => ({ rows: p.rows, data: p.data.slice() });

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
    if (replacement) this.song.patterns[index] = replacement;
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

  undo(): string | null {
    return this.history.undo()?.label ?? null;
  }

  redo(): string | null {
    return this.history.redo()?.label ?? null;
  }
}
