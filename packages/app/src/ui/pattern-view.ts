import { CELL_SIZE, noteName, type Block, type Pattern, type Song } from '@webtracker/engine';

const EFFECT_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Volume column commands 0x6..0xF, MilkyTracker spelling.
export const VOLUME_COMMANDS = '-+DUSVPLRM';

export const hex = (v: number, digits = 2) => v.toString(16).toUpperCase().padStart(digits, '0');

export function formatVolume(v: number): string {
  if (v < 0x10) return '..';
  if (v <= 0x50) return hex(v - 0x10, 2);
  return (VOLUME_COMMANDS[(v >> 4) - 6] ?? '?') + hex(v & 0x0f, 1);
}

export function formatEffect(effect: number, param: number): string {
  if (effect === 0 && param === 0) return '...';
  return (EFFECT_CHARS[effect] ?? '?') + hex(param, 2);
}

/**
 * Cursor columns inside a channel: note, instrument (2 digits), volume
 * (2 digits), effect, effect parameter (2 digits).
 */
export const COLUMNS = 8;
export const Column = { Note: 0, InsHi: 1, InsLo: 2, VolHi: 3, VolLo: 4, Effect: 5, ParamHi: 6, ParamLo: 7 } as const;

/** Someone else's cursor in a jam. */
export interface PeerMark {
  pattern: number;
  row: number;
  channel: number;
  colour: string;
  name: string;
}

/** Where the cursor and selection are, for drawing. */
export interface ViewState {
  row: number;
  channel: number;
  column: number;
  selection: Block | null;
  /** Other people's cursors in this pattern. */
  peers?: PeerMark[];
}

const escapeAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** First column of each field, and how many characters it has. */
const FIELDS = [
  { cls: 'n', column: Column.Note },
  { cls: 'i', column: Column.InsHi },
  { cls: 'v', column: Column.VolHi },
  { cls: 'e', column: Column.Effect },
  { cls: 'x', column: Column.ParamHi },
] as const;

function field(cls: string, column: number, text: string, empty: boolean, cursorColumn: number): string {
  const base = `${cls}${empty ? ' empty' : ''}`;
  const offset = cursorColumn - column;
  if (cursorColumn < 0 || offset < 0 || offset >= text.length || (cls === 'n' && offset > 0)) {
    return `<span class="${base}" data-col="${column}">${text}</span>`;
  }
  if (cls === 'n' || text.length === 1) return `<span class="${base} k" data-col="${column}">${text}</span>`;
  // Two-digit fields at the cursor are split so the active digit can be marked.
  const digits = [...text].map((ch, i) => `<span data-col="${column + i}"${i === offset ? ' class="k"' : ''}>${ch}</span>`);
  return `<span class="${base}">${digits.join('')}</span>`;
}

/** Inner HTML of one row: a `.rn` row number and one `.c` per channel with `.n .i .v .e .x` fields. */
export function rowHtml(song: Song, pattern: Pattern, row: number, view: ViewState | null = null): string {
  const d = pattern.data;
  const sel = view?.selection;
  const rowSelected = sel && row >= sel.row0 && row <= sel.row1;
  let html = `<span class="rn">${hex(row, 2)}</span>`;
  for (let ch = 0; ch < song.channels; ch++) {
    const o = (row * song.channels + ch) * CELL_SIZE;
    const [note = 0, ins = 0, vol = 0, eff = 0, par = 0] = d.subarray(o, o + CELL_SIZE);
    const fx = formatEffect(eff, par);
    const noFx = !eff && !par;
    const at = view !== null && view.row === row && view.channel === ch;
    const selected = rowSelected && ch >= sel.ch0 && ch <= sel.ch1;
    const cursorColumn = at ? view.column : -1;
    const peer = view?.peers?.find((m) => m.row === row && m.channel === ch);
    const mark = peer ? ` peer" style="--peer: ${escapeAttr(peer.colour)}" title="${escapeAttr(peer.name)}` : '';
    const texts = [note ? noteName(note) : '---', ins ? hex(ins, 2) : '..', formatVolume(vol), fx.slice(0, 1), fx.slice(1)];
    const empties = [!note, !ins, vol < 0x10, noFx, noFx];
    html += `<span class="c${at ? ' at' : ''}${selected ? ' sel' : ''}${mark}" data-channel="${ch}">`;
    FIELDS.forEach((f, i) => {
      html += field(f.cls, f.column, texts[i]!, empties[i]!, cursorColumn);
    });
    html += '</span>';
  }
  return html;
}
