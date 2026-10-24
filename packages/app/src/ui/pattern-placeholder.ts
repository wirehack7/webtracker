import { noteName } from '@webtracker/engine';

// Stand-in pattern editor until the real pattern view lands. It renders the
// same markup (.r rows with .rn and one .c per channel holding .n/.i/.v/.e/.x)
// so the theme in style.css applies unchanged.

export const ROWS = 64;
export const CHANNELS = 8;

interface Cell {
  note: number;
  instrument: number;
}

export class PatternPlaceholder {
  private readonly cells: Cell[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: CHANNELS }, () => ({ note: 0, instrument: 0 })),
  );
  private readonly rows: HTMLDivElement[] = [];
  row = 0;
  channel = 0;

  constructor(private readonly container: HTMLElement) {
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement('div');
      row.className = r % 4 === 0 ? 'r beat' : 'r';
      row.dataset.row = String(r);
      this.rows.push(row);
      this.renderRow(r);
    }
    container.replaceChildren(...this.rows);
    container.addEventListener('pointerdown', (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>('.c');
      const row = cell?.closest<HTMLElement>('.r');
      if (!cell?.dataset.channel || !row?.dataset.row) return;
      this.moveTo(Number(row.dataset.row), Number(cell.dataset.channel));
    });
    this.moveTo(0, 0);
  }

  moveTo(row: number, channel: number): void {
    const previous = this.row;
    this.row = (row + ROWS) % ROWS;
    this.channel = (channel + CHANNELS) % CHANNELS;
    this.rows[previous]?.classList.remove('cur');
    this.renderRow(previous);
    this.rows[this.row]?.classList.add('cur');
    this.renderRow(this.row);
    this.rows[this.row]?.scrollIntoView({ block: 'center', inline: 'nearest' });
    this.container
      .querySelector('.c.at')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Writes a note (0 clears) at the cursor. */
  write(note: number, instrument: number): void {
    const cell = this.cells[this.row]?.[this.channel];
    if (!cell) return;
    cell.note = note;
    cell.instrument = note ? instrument : 0;
    this.renderRow(this.row);
  }

  private renderRow(r: number): void {
    const row = this.rows[r];
    const cells = this.cells[r];
    if (!row || !cells) return;
    const rn = span('rn', hex(r));
    const channels = cells.map((cell, c) => {
      const el = document.createElement('span');
      el.className = r === this.row && c === this.channel ? 'c at' : 'c';
      el.dataset.channel = String(c);
      el.append(
        cell.note ? span('n', noteName(cell.note)) : span('n empty', '---'),
        cell.instrument ? span('i', hex(cell.instrument)) : span('i empty', '..'),
        span('v empty', '..'),
        span('e empty', '.'),
        span('x empty', '..'),
      );
      return el;
    });
    row.replaceChildren(rn, ...channels);
  }
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

export function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}
