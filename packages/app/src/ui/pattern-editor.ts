import { blockBetween, emptyPattern, type Block, type Pattern, type Song } from '@webtracker/engine';
import { COLUMNS, rowHtml, type ViewState } from './pattern-view.ts';

/**
 * Pattern editor view: draws one pattern of the song, owns the cursor and the
 * block selection, and turns mouse input into cursor moves. Changing the song
 * is up to the caller, which then calls `render`.
 */
export class PatternEditor {
  row = 0;
  channel = 0;
  column = 0;
  selection: Block | null = null;
  /** Corner the selection grows from while Shift or the mouse button is held. */
  private anchor: { row: number; channel: number } | null = null;
  private rows: HTMLDivElement[] = [];
  private song: Song | null = null;
  patternIndex = 0;
  /** Called when the cursor moves through the mouse. */
  onCursor: (() => void) | null = null;

  constructor(readonly container: HTMLElement) {
    container.addEventListener('pointerdown', (event) => {
      const hit = this.hitTest(event.target);
      if (!hit) return;
      container.focus({ preventScroll: true });
      if (!event.shiftKey && this.selection) {
        this.selection = null;
        this.render();
      }
      this.moveTo(hit.row, hit.channel, hit.column ?? this.column, event.shiftKey);
      // Dragging selects; a plain click starts a new anchor here.
      if (!event.shiftKey) this.anchor = { row: hit.row, channel: hit.channel };
      this.onCursor?.();
    });
    container.addEventListener('pointermove', (event) => {
      if (event.buttons !== 1 || event.pointerType === 'touch' || !this.anchor) return;
      const hit = this.hitTest(document.elementFromPoint(event.clientX, event.clientY));
      if (!hit || (hit.row === this.row && hit.channel === this.channel)) return;
      this.moveTo(hit.row, hit.channel, this.column, true);
      this.onCursor?.();
    });
  }

  get pattern(): Pattern {
    return this.song?.patterns[this.patternIndex] ?? emptyPattern(64, this.song?.channels ?? 1);
  }

  private get channels(): number {
    return this.song?.channels ?? 1;
  }

  private view(): ViewState {
    return { row: this.row, channel: this.channel, column: this.column, selection: this.selection };
  }

  private hitTest(target: EventTarget | null): { row: number; channel: number; column: number | null } | null {
    const el = target instanceof HTMLElement ? target : null;
    const cell = el?.closest<HTMLElement>('.c');
    const row = cell?.closest<HTMLElement>('.r');
    if (!cell?.dataset.channel || !row?.dataset.row) return null;
    const col = el?.closest<HTMLElement>('[data-col]')?.dataset.col;
    return { row: Number(row.dataset.row), channel: Number(cell.dataset.channel), column: col === undefined ? null : Number(col) };
  }

  /** Shows pattern `index` of the song, keeping the cursor where it fits. */
  show(song: Song, index: number): void {
    const changed = song !== this.song || index !== this.patternIndex;
    this.song = song;
    this.patternIndex = index;
    if (changed) this.selection = null;
    this.row = Math.min(this.row, this.pattern.rows - 1);
    this.channel = Math.min(this.channel, song.channels - 1);
    this.render();
  }

  /** Redraws every row, after edits or a new pattern. */
  render(): void {
    const song = this.song;
    if (!song) return;
    const pattern = this.pattern;
    const view = this.view();
    const rows: HTMLDivElement[] = [];
    for (let r = 0; r < pattern.rows; r++) {
      const div = this.rows[r] ?? document.createElement('div');
      div.className = `r${r % 4 === 0 ? ' beat' : ''}${r === this.row ? ' cur' : ''}`;
      div.dataset.row = String(r);
      div.innerHTML = rowHtml(song, pattern, r, view);
      rows.push(div);
    }
    this.rows = rows;
    this.container.replaceChildren(...rows);
    this.scrollToCursor();
  }

  private renderRow(r: number): void {
    const div = this.rows[r];
    if (!div || !this.song) return;
    div.className = `r${r % 4 === 0 ? ' beat' : ''}${r === this.row ? ' cur' : ''}`;
    div.innerHTML = rowHtml(this.song, this.pattern, r, this.view());
  }

  /**
   * Moves the cursor. Rows wrap around the pattern like in FT2. With `extend`
   * the selection grows from where the cursor was.
   */
  moveTo(row: number, channel: number, column = this.column, extend = false): void {
    const rows = this.pattern.rows;
    const before = { row: this.row, selection: this.selection };
    if (extend) this.anchor ??= { row: this.row, channel: this.channel };
    else this.anchor = null;

    this.row = ((row % rows) + rows) % rows;
    this.channel = ((channel % this.channels) + this.channels) % this.channels;
    this.column = Math.max(0, Math.min(COLUMNS - 1, column));
    if (extend && this.anchor) {
      this.selection = blockBetween(this.anchor.row, this.anchor.channel, this.row, this.channel);
    }

    if (this.selection !== before.selection) {
      this.render();
    } else {
      this.renderRow(before.row);
      this.renderRow(this.row);
      this.scrollToCursor();
    }
  }

  /** Steps through the columns, crossing into the next or previous channel. */
  moveColumn(delta: number): void {
    let column = this.column + delta;
    let channel = this.channel;
    if (column >= COLUMNS) {
      column = 0;
      channel++;
    } else if (column < 0) {
      column = COLUMNS - 1;
      channel--;
    }
    this.moveTo(this.row, channel, column);
  }

  /** Keeps the cursor on the playing row while the song plays. */
  follow(index: number, row: number): void {
    if (!this.song) return;
    if (index !== this.patternIndex) {
      this.patternIndex = index;
      this.row = row;
      this.selection = null;
      this.render();
      return;
    }
    if (row !== this.row) this.moveTo(row, this.channel, this.column, false);
  }

  setSelection(selection: Block | null): void {
    this.selection = selection;
    this.anchor = null;
    this.render();
  }

  /** The selection, or the cell under the cursor when nothing is selected. */
  blockOrCursor(): Block {
    return this.selection ?? { row0: this.row, row1: this.row, ch0: this.channel, ch1: this.channel };
  }

  private scrollToCursor(): void {
    const el = this.rows[this.row];
    if (!el) return;
    const c = this.container;
    // Only scroll the pattern itself, not the page around it.
    const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    c.scrollTop = top - c.clientHeight / 2 + el.offsetHeight / 2;
    const cell = el.querySelector<HTMLElement>('.c.at');
    if (!cell) return;
    const rn = el.querySelector<HTMLElement>('.rn')?.offsetWidth ?? 0;
    const left = cell.offsetLeft - rn;
    const right = cell.offsetLeft + cell.offsetWidth;
    if (left < c.scrollLeft) c.scrollLeft = left;
    else if (right > c.scrollLeft + c.clientWidth) c.scrollLeft = right - c.clientWidth;
  }
}
