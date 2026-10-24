import { CELL_SIZE, noteName, type Pattern, type Song } from '@webtracker/engine';

const EFFECT_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Volume column commands 0x6..0xF, MilkyTracker spelling.
const VOLUME_COMMANDS = '-+DUSVPLRM';

const hex = (v: number, digits: number) => v.toString(16).toUpperCase().padStart(digits, '0');

export function formatVolume(v: number): string {
  if (v < 0x10) return '..';
  if (v <= 0x50) return hex(v - 0x10, 2);
  return (VOLUME_COMMANDS[(v >> 4) - 6] ?? '?') + hex(v & 0x0f, 1);
}

export function formatEffect(effect: number, param: number): string {
  if (effect === 0 && param === 0) return '...';
  return (EFFECT_CHARS[effect] ?? '?') + hex(param, 2);
}

function field(cls: string, text: string, empty: boolean): string {
  return `<span class="${cls}${empty ? ' empty' : ''}">${text}</span>`;
}

/**
 * Renders a pattern into `container`, one `.r` element per row with a `.rn`
 * row number and one `.c` span per channel holding `.n .i .v .e` fields.
 * Returns the row elements so the caller can mark the playing row.
 */
export function renderPattern(container: HTMLElement, song: Song, pattern: Pattern, showVolume: boolean): HTMLElement[] {
  container.textContent = '';
  const rows: HTMLElement[] = [];
  const fragment = document.createDocumentFragment();
  const d = pattern.data;
  for (let row = 0; row < pattern.rows; row++) {
    const div = document.createElement('div');
    div.className = row % 4 === 0 ? 'r beat' : 'r';
    let html = `<span class="rn">${hex(row, 2)}</span>`;
    for (let ch = 0; ch < song.channels; ch++) {
      const o = (row * song.channels + ch) * CELL_SIZE;
      const [note = 0, ins = 0, vol = 0, eff = 0, par = 0] = d.subarray(o, o + CELL_SIZE);
      html += '<span class="c">';
      html += field('n', note ? noteName(note) : '---', !note);
      html += field('i', ins ? hex(ins, 2) : '..', !ins);
      if (showVolume) html += field('v', formatVolume(vol), vol < 0x10);
      html += field('e', formatEffect(eff, par), !eff && !par);
      html += '</span>';
    }
    div.innerHTML = html;
    rows.push(div);
    fragment.appendChild(div);
  }
  container.appendChild(fragment);
  return rows;
}

/** Marks `row` as playing and scrolls it to the vertical centre. */
export function highlightRow(container: HTMLElement, rows: HTMLElement[], row: number): void {
  for (const el of container.querySelectorAll('.r.cur')) el.classList.remove('cur');
  const el = rows[row];
  if (!el) return;
  el.classList.add('cur');
  container.scrollTop = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
}
