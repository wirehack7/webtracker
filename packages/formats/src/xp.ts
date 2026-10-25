/**
 * FastTracker 2 pattern (.xp) and track (.xt) files: a version word, the
 * row count and unpacked XM cells. Pattern files always hold 32 channels.
 */
import { CELL_SIZE, NOTE_KEY_OFF, type Pattern, type Song } from '@webtracker/engine';

const XP_CHANNELS = 32;

function header(rows: number, size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(4 + size);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, rows, true);
  return { bytes, view };
}

/** Rows in an .xp or .xt file, or null when it is not one. */
function readHeader(bytes: Uint8Array, channels: number): number | null {
  if (bytes.length < 4) return null;
  const version = bytes[0]! | (bytes[1]! << 8);
  const rows = bytes[2]! | (bytes[3]! << 8);
  if (version !== 1 || rows < 1 || rows > 256 || bytes.length < 4 + rows * channels * CELL_SIZE) return null;
  return rows;
}

function cleanCell(cells: Uint8Array, o: number): void {
  if (cells[o]! > NOTE_KEY_OFF) cells[o] = 0;
  if (cells[o + 1]! > 128) cells[o + 1] = 0;
}

export function saveXp(song: Song, pattern: Pattern): Uint8Array {
  const { bytes } = header(pattern.rows, pattern.rows * XP_CHANNELS * CELL_SIZE);
  const channels = Math.min(song.channels, XP_CHANNELS);
  for (let row = 0; row < pattern.rows; row++) {
    const from = row * song.channels * CELL_SIZE;
    bytes.set(pattern.data.subarray(from, from + channels * CELL_SIZE), 4 + row * XP_CHANNELS * CELL_SIZE);
  }
  return bytes;
}

export function saveXt(song: Song, pattern: Pattern, channel: number): Uint8Array {
  const { bytes } = header(pattern.rows, pattern.rows * CELL_SIZE);
  for (let row = 0; row < pattern.rows; row++) {
    const from = (row * song.channels + channel) * CELL_SIZE;
    bytes.set(pattern.data.subarray(from, from + CELL_SIZE), 4 + row * CELL_SIZE);
  }
  return bytes;
}

export interface LoadedXp {
  pattern: Pattern;
  /** Channels past the song's channel count that held notes or effects. */
  droppedChannels: number;
}

/** Reads an .xp file into a pattern laid out for `channels` channels. */
export function loadXp(bytes: Uint8Array, channels: number): LoadedXp {
  const rows = readHeader(bytes, XP_CHANNELS);
  if (rows === null) throw new Error('Not an XP pattern file');
  const data = new Uint8Array(rows * channels * CELL_SIZE);
  const used = new Set<number>();
  for (let row = 0; row < rows; row++) {
    for (let c = 0; c < XP_CHANNELS; c++) {
      const from = 4 + (row * XP_CHANNELS + c) * CELL_SIZE;
      if (c >= channels) {
        if (bytes.subarray(from, from + CELL_SIZE).some((b) => b)) used.add(c);
        continue;
      }
      const to = (row * channels + c) * CELL_SIZE;
      data.set(bytes.subarray(from, from + CELL_SIZE), to);
      cleanCell(data, to);
    }
  }
  return { pattern: { rows, data }, droppedChannels: used.size };
}

/** Reads an .xt file: one cell per row. */
export function loadXt(bytes: Uint8Array): Uint8Array {
  const rows = readHeader(bytes, 1);
  if (rows === null) throw new Error('Not an XT track file');
  const cells = bytes.slice(4, 4 + rows * CELL_SIZE);
  for (let o = 0; o < cells.length; o += CELL_SIZE) cleanCell(cells, o);
  return cells;
}

/** Writes track cells into `channel` of the pattern, as far as the pattern reaches. */
export function applyTrack(song: Song, pattern: Pattern, channel: number, cells: Uint8Array): void {
  const rows = Math.min(pattern.rows, cells.length / CELL_SIZE);
  for (let row = 0; row < rows; row++) {
    pattern.data.set(cells.subarray(row * CELL_SIZE, (row + 1) * CELL_SIZE), (row * song.channels + channel) * CELL_SIZE);
  }
}
