/**
 * Draws one video frame in the tracker's look: the song title and position,
 * a scope per channel and the pattern scrolling under a fixed play row. Works
 * on an OffscreenCanvas in the export worker and on a page canvas alike.
 */
import { CELL_SIZE, noteName, type PlayerState, type Song } from '@webtracker/engine';
import { formatEffect, formatVolume, hex } from '../ui/pattern-view.ts';
import { SCOPE_POINTS } from './frames.ts';

export const VIDEO_FONT = 'Press Start 2P';

export interface VideoTheme {
  desk: string;
  deskLo: string;
  text: string;
  label: string;
  dim: string;
  bg: string;
  rowhl: string;
  rowhl2: string;
  cursor: string;
  rn: string;
  sep: string;
  note: string;
  instr: string;
  vol: string;
  fx: string;
  param: string;
  empty: string;
  scope: string;
}

/** The CSS custom property behind each colour, so videos follow the theme. */
export const THEME_PROPERTIES: Record<keyof VideoTheme, string> = {
  desk: '--desk',
  deskLo: '--desk-lo',
  text: '--text',
  label: '--label',
  dim: '--dim',
  bg: '--pat-bg',
  rowhl: '--pat-rowhl',
  rowhl2: '--pat-rowhl2',
  cursor: '--pat-cursor',
  rn: '--pat-rn',
  sep: '--pat-sep',
  note: '--pat-note',
  instr: '--pat-instr',
  vol: '--pat-vol',
  fx: '--pat-fx',
  param: '--pat-param',
  empty: '--pat-empty',
  scope: '--scope-line',
};

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoLayout {
  width: number;
  height: number;
  /** Thickness of lines and gaps; 2 px at 720p, 3 px at 1080p. */
  unit: number;
  header: Box;
  titleSize: number;
  infoSize: number;
  scopes: Box;
  scopeColumns: number;
  pattern: Box;
  /** Pattern font size; the font is square, so also the width of a character. */
  font: number;
  rowHeight: number;
  /** Characters per channel: 13 all fields, 10 without volume, 6 note and instrument, 3 note only. */
  chars: number;
  rowNumberWidth: number;
  channelWidth: number;
}

const TIERS = [13, 10, 6, 3];

/** Splits the frame into header, scopes and pattern, with the largest pattern font that fits the channels. */
export function videoLayout(width: number, height: number, channels: number): VideoLayout {
  const unit = Math.max(1, Math.round(Math.min(width, height) / 360));
  const margin = unit * 4;
  const inner = width - margin * 2;
  const titleSize = unit * 8;
  const infoSize = unit * 5;
  const header = { x: margin, y: margin, w: inner, h: titleSize + infoSize + unit * 10 };

  const portrait = height > width;
  const scopeColumns = Math.min(channels, portrait ? 4 : 8);
  const scopeRows = Math.ceil(channels / Math.max(1, scopeColumns));
  const scopeHeight = Math.round(height * (portrait ? 0.16 : 0.2) * Math.min(1.5, Math.sqrt(scopeRows)));
  const scopes = { x: margin, y: header.y + header.h + margin, w: inner, h: scopeHeight };
  const top = scopes.y + scopes.h + margin;
  const pattern = { x: margin, y: top, w: inner, h: height - margin - top };

  // Largest font for the fullest columns; drop columns before going below the minimum.
  const maxFont = unit * 8;
  const minFont = unit * 5;
  let font = minFont;
  let chars = TIERS[TIERS.length - 1]!;
  for (const tier of TIERS) {
    const fit = Math.floor((pattern.w - unit * 4) / (3 + channels * (tier + 1)));
    if (fit >= minFont || tier === chars) {
      font = Math.max(1, Math.min(maxFont, fit));
      chars = tier;
      break;
    }
  }
  const rowNumberWidth = font * 3;
  return {
    width,
    height,
    unit,
    header,
    titleSize,
    infoSize,
    scopes,
    scopeColumns,
    pattern,
    font,
    rowHeight: Math.round(font * 1.5),
    chars,
    rowNumberWidth,
    channelWidth: Math.floor((pattern.w - rowNumberWidth) / Math.max(1, channels)),
  };
}

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface PainterOptions {
  song: Song;
  title: string;
  theme: VideoTheme;
  layout: VideoLayout;
  /** Muted channels draw a flat, dimmed scope. */
  muted: boolean[];
  /** Row highlights as in the editor; 0 is off. */
  beat: number;
  bar: number;
  /** Makes the scratch canvas a pattern is drawn on once. */
  makeCanvas: (width: number, height: number) => Canvas;
}

export const fontFor = (size: number) => `${size}px "${VIDEO_FONT}", monospace`;

export const formatClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export class VideoPainter {
  // Each pattern's text is drawn once and then copied into every frame that shows it.
  private patterns = new Map<number, Canvas>();

  constructor(private readonly options: PainterOptions) {}

  draw(g: Context, state: PlayerState, scopes: Float32Array[], time: number): void {
    const { layout, theme } = this.options;
    g.fillStyle = theme.desk;
    g.fillRect(0, 0, layout.width, layout.height);
    this.drawHeader(g, state, time);
    this.drawScopes(g, scopes);
    this.drawPattern(g, state);
  }

  private field(g: Context, box: Box): void {
    const { unit } = this.options.layout;
    g.fillStyle = this.options.theme.deskLo;
    g.fillRect(box.x - unit, box.y - unit, box.w + unit * 2, box.h + unit * 2);
    g.fillStyle = this.options.theme.bg;
    g.fillRect(box.x, box.y, box.w, box.h);
  }

  private drawHeader(g: Context, state: PlayerState, time: number): void {
    const { layout, theme, song, title } = this.options;
    const { header, unit, titleSize, infoSize } = layout;
    const pad = unit * 4;
    g.textBaseline = 'top';
    g.font = fontFor(infoSize);
    const brand = 'chiptrackr';
    const brandWidth = g.measureText(brand).width;
    g.fillStyle = theme.dim;
    g.fillText(brand, header.x + header.w - pad - brandWidth, header.y + pad + (titleSize - infoSize));

    g.font = fontFor(titleSize);
    g.fillStyle = theme.text;
    g.fillText(clip(g, title, header.w - pad * 3 - brandWidth), header.x + pad, header.y + pad);

    const info = [
      `POS ${hex(state.order, 2)}/${hex(Math.max(0, song.orders.length - 1), 2)}`,
      `PAT ${hex(state.pattern, 2)}`,
      `ROW ${hex(state.row, 2)}`,
      `SPD ${String(state.speed).padStart(2, '0')}`,
      `BPM ${state.tempo}`,
      formatClock(time),
    ].join('  ');
    g.font = fontFor(infoSize);
    g.fillStyle = theme.label;
    g.fillText(clip(g, info, header.w - pad * 2), header.x + pad, header.y + pad + titleSize + unit * 3);
  }

  private drawScopes(g: Context, waves: Float32Array[]): void {
    const { layout, theme, song, muted } = this.options;
    const { scopes, scopeColumns, unit, infoSize } = layout;
    const rows = Math.ceil(song.channels / Math.max(1, scopeColumns));
    const gap = unit * 3;
    const w = Math.floor((scopes.w - gap * (scopeColumns - 1)) / scopeColumns);
    const h = Math.floor((scopes.h - gap * (rows - 1)) / rows);
    for (let c = 0; c < song.channels; c++) {
      const box = { x: scopes.x + (c % scopeColumns) * (w + gap), y: scopes.y + Math.floor(c / scopeColumns) * (h + gap), w, h };
      this.field(g, box);
      const off = muted[c] === true;
      g.font = fontFor(infoSize);
      g.textBaseline = 'top';
      g.fillStyle = theme.dim;
      g.fillText(String(c + 1).padStart(2, '0'), box.x + unit * 2, box.y + unit * 2);
      g.fillStyle = off ? theme.empty : theme.scope;
      const mid = Math.round(box.y + (h - unit) / 2);
      const wave = waves[c];
      if (off || !wave) {
        g.fillRect(box.x, mid, w, unit);
        continue;
      }
      const amp = ((h - unit) / 2) * 0.85;
      let prev = mid;
      for (let x = 0; x < w; x += unit) {
        const y = Math.round(mid - wave[Math.floor((x * SCOPE_POINTS) / w)]! * amp);
        // Join to the previous column so steep edges stay connected.
        const top = Math.min(prev, y);
        g.fillRect(box.x + x, top, Math.min(unit, w - x), Math.max(prev, y) - top + unit);
        prev = y;
      }
    }
  }

  private drawPattern(g: Context, state: PlayerState): void {
    const { layout, theme, song, beat, bar } = this.options;
    const { pattern: box, rowHeight, unit } = layout;
    this.field(g, box);
    const pattern = song.patterns[state.pattern];
    if (!pattern) return;
    const half = Math.ceil(box.h / rowHeight / 2);
    // The play row sits in the middle; the rows around it scroll past.
    const centre = box.y + Math.floor((box.h - rowHeight) / 2);
    const first = Math.max(0, state.row - half);
    const last = Math.min(pattern.rows - 1, state.row + half);
    g.save();
    g.beginPath();
    g.rect(box.x, box.y, box.w, box.h);
    g.clip();
    for (let r = first; r <= last; r++) {
      const fill =
        r === state.row ? theme.cursor : bar > 0 && r % bar === 0 ? theme.rowhl2 : beat > 0 && r % beat === 0 ? theme.rowhl : '';
      if (!fill) continue;
      g.fillStyle = fill;
      g.fillRect(box.x, centre + (r - state.row) * rowHeight, box.w, rowHeight);
    }
    const copy = (index: number, from: number, to: number, y: number) => {
      if (to < from) return;
      const h = (to - from + 1) * rowHeight;
      g.drawImage(this.patternText(index), 0, from * rowHeight, box.w, h, box.x, y, box.w, h);
    };
    copy(state.pattern, first, last, centre + (first - state.row) * rowHeight);
    // The positions before and after show dimmed, as in the editor.
    g.globalAlpha = 0.4;
    const before = song.orders[state.order - 1];
    const previous = before === undefined ? undefined : song.patterns[before];
    if (previous && state.row - half < 0) {
      const from = Math.max(0, previous.rows - (half - state.row));
      copy(before!, from, previous.rows - 1, centre - (state.row + previous.rows - from) * rowHeight);
    }
    const after = song.orders[state.order + 1];
    const next = after === undefined ? undefined : song.patterns[after];
    if (next && state.row + half > pattern.rows - 1) {
      copy(after!, 0, Math.min(next.rows - 1, state.row + half - pattern.rows), centre + (pattern.rows - state.row) * rowHeight);
    }
    g.restore();
    g.fillStyle = theme.sep;
    for (let c = 0; c < song.channels; c++) {
      g.fillRect(box.x + layout.rowNumberWidth + c * layout.channelWidth, box.y, unit, box.h);
    }
  }

  /** The pattern's text on a transparent canvas, one row under the other. */
  private patternText(index: number): Canvas {
    const cached = this.patterns.get(index);
    if (cached) {
      // Most recently used last, so the oldest is the one to drop.
      this.patterns.delete(index);
      this.patterns.set(index, cached);
      return cached;
    }
    const { layout, theme, song, makeCanvas } = this.options;
    const pattern = song.patterns[index]!;
    const { font, rowHeight, chars, channelWidth, rowNumberWidth } = layout;
    const canvas = makeCanvas(layout.pattern.w, Math.max(1, pattern.rows * rowHeight));
    const g = canvas.getContext('2d') as Context;
    g.font = fontFor(font);
    g.textBaseline = 'top';
    const lift = Math.floor((rowHeight - font) / 2);
    const pad = Math.max(1, Math.floor(font / 2));
    for (let r = 0; r < pattern.rows; r++) {
      const y = r * rowHeight + lift;
      g.fillStyle = theme.rn;
      g.fillText(hex(r, 2), pad, y);
      for (let c = 0; c < song.channels; c++) {
        const o = (r * song.channels + c) * CELL_SIZE;
        const [note = 0, ins = 0, vol = 0, eff = 0, par = 0] = pattern.data.subarray(o, o + CELL_SIZE);
        const fx = formatEffect(eff, par);
        const noFx = !eff && !par;
        // Text, empty, colour, and the gap after it: the effect parameter follows its command directly.
        const fields: [string, boolean, string, number][] = [[note ? noteName(note) : '---', !note, theme.note, 1]];
        if (chars >= 6) fields.push([ins ? hex(ins, 2) : '..', !ins, theme.instr, 1]);
        if (chars >= 13) fields.push([formatVolume(vol), vol < 0x10, theme.vol, 1]);
        if (chars >= 10) fields.push([fx.slice(0, 1), noFx, theme.fx, 0], [fx.slice(1), noFx, theme.param, 1]);
        let x = rowNumberWidth + c * channelWidth + pad;
        for (const [value, empty, colour, gap] of fields) {
          g.fillStyle = empty ? theme.empty : colour;
          g.fillText(value, x, y);
          x += (value.length + gap) * font;
        }
      }
    }
    // The pattern before, the one playing and the next; older ones are dropped.
    if (this.patterns.size >= 3) this.patterns.delete(this.patterns.keys().next().value!);
    this.patterns.set(index, canvas);
    return canvas;
  }
}

/** Shortens text with an ellipsis until it fits `width`. */
function clip(g: Context, text: string, width: number): string {
  if (g.measureText(text).width <= width) return text;
  let out = text;
  while (out.length > 1 && g.measureText(`${out}...`).width > width) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}
