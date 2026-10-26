// @vitest-environment happy-dom
import { createSong, emptyPattern, writeCell, type Song } from '@webtracker/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PatternEditor } from './pattern-editor.ts';
import { Column } from './pattern-view.ts';

/** The pattern editor's cursor, selection and mouse handling, in a DOM. */

let song: Song;
let container: HTMLDivElement;
let editor: PatternEditor;

beforeEach(() => {
  song = createSong(4);
  song.patterns[0] = emptyPattern(16, 4);
  song.patterns[1] = emptyPattern(8, 4);
  writeCell(song, song.patterns[0], 2, 1, { note: 49, instrument: 1 });
  container = document.createElement('div');
  document.body.replaceChildren(container);
  editor = new PatternEditor(container);
  editor.show(song, 0);
});

const rowEl = (r: number) => container.querySelector<HTMLElement>(`[data-row="${r}"]`)!;
const cellEl = (r: number, ch: number) => rowEl(r).querySelector<HTMLElement>(`.c[data-channel="${ch}"]`)!;

describe('PatternEditor', () => {
  it('draws one row per pattern row with beat and bar highlights', () => {
    expect(container.querySelectorAll('.r')).toHaveLength(16);
    expect(rowEl(0).className).toBe('r beat bar cur');
    expect(rowEl(4).className).toBe('r beat');
    expect(rowEl(5).className).toBe('r');
    expect(cellEl(2, 1).textContent).toContain('C-4');
    editor.beat = 0;
    editor.bar = 8;
    editor.render();
    expect(rowEl(4).className).toBe('r');
    expect(rowEl(8).className).toBe('r bar');
  });

  it('wraps the cursor around the pattern and the channels, or stops at the ends', () => {
    const moved = vi.fn();
    editor.onMoved = moved;
    editor.moveTo(-1, 4);
    expect([editor.row, editor.channel]).toEqual([15, 0]);
    expect(rowEl(15).classList.contains('cur')).toBe(true);
    expect(rowEl(0).classList.contains('cur')).toBe(false);
    editor.wrap = false;
    editor.moveTo(20, -1, 99);
    expect([editor.row, editor.channel, editor.column]).toEqual([15, 3, Column.ParamLo]);
    editor.moveTo(-3, 0);
    expect(editor.row).toBe(0);
    expect(moved).toHaveBeenCalledTimes(3);
  });

  it('steps through columns into the next and previous channel', () => {
    editor.moveTo(0, 0, Column.ParamLo);
    editor.moveColumn(1);
    expect([editor.channel, editor.column]).toEqual([1, 0]);
    editor.moveColumn(-1);
    expect([editor.channel, editor.column]).toEqual([0, Column.ParamLo]);
  });

  it('grows a selection from where the cursor was with extend, and clears it on a plain move', () => {
    editor.moveTo(1, 0);
    editor.moveTo(3, 2, 0, true);
    expect(editor.selection).toEqual({ row0: 1, row1: 3, ch0: 0, ch1: 2 });
    expect(editor.blockOrCursor()).toEqual(editor.selection);
    expect(cellEl(2, 1).classList.contains('sel')).toBe(true);
    editor.setSelection(null);
    expect(editor.blockOrCursor()).toEqual({ row0: 3, row1: 3, ch0: 2, ch1: 2 });
    expect(container.querySelector('.sel')).toBeNull();
  });

  it('moves the cursor to the clicked field, selects by dragging and with Shift', () => {
    const onCursor = vi.fn();
    editor.onCursor = onCursor;
    const field = cellEl(2, 1).querySelector<HTMLElement>('[data-col="3"]')!;
    field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect([editor.row, editor.channel, editor.column]).toEqual([2, 1, Column.VolHi]);
    expect(onCursor).toHaveBeenCalledOnce();

    // Dragging over another cell selects from where the press started.
    document.elementFromPoint = () => cellEl(5, 2);
    container.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, pointerType: 'mouse' }));
    expect(editor.selection).toEqual({ row0: 2, row1: 5, ch0: 1, ch1: 2 });
    // Touch moves scroll instead, and moving within the same cell does nothing.
    document.elementFromPoint = () => cellEl(9, 3);
    container.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, pointerType: 'touch' }));
    document.elementFromPoint = () => cellEl(5, 2);
    container.dispatchEvent(new PointerEvent('pointermove', { buttons: 1, pointerType: 'mouse' }));
    expect(editor.selection).toEqual({ row0: 2, row1: 5, ch0: 1, ch1: 2 });

    // A plain click elsewhere drops the selection; Shift+click extends it.
    cellEl(7, 0).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(editor.selection).toBeNull();
    cellEl(9, 1).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, shiftKey: true }));
    expect(editor.selection).toEqual({ row0: 7, row1: 9, ch0: 0, ch1: 1 });
    // A press outside the cells is not a cursor move.
    container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(onCursor).toHaveBeenCalledTimes(4);
  });

  it('follows playback into another pattern and along its rows', () => {
    editor.setSelection({ row0: 0, row1: 1, ch0: 0, ch1: 0 });
    editor.follow(1, 3);
    expect([editor.patternIndex, editor.row, editor.selection]).toEqual([1, 3, null]);
    expect(container.querySelectorAll('.r')).toHaveLength(8);
    editor.follow(1, 5);
    expect(editor.row).toBe(5);
    expect(rowEl(5).classList.contains('cur')).toBe(true);
  });

  it('keeps the cursor inside a smaller pattern or song', () => {
    editor.moveTo(15, 3);
    editor.show(song, 1);
    expect([editor.row, editor.channel]).toEqual([7, 3]);
    const small = createSong(2);
    editor.show(small, 0);
    expect(editor.channel).toBe(1);
  });

  it('shows the neighbouring patterns dimmed in the prospective view', () => {
    editor.prospective = true;
    editor.neighbours = () => [song.patterns[1]!, song.patterns[1]!];
    editor.render();
    const ghosts = container.querySelectorAll('.ghost');
    expect(ghosts).toHaveLength(16);
    expect(container.firstElementChild!.classList.contains('ghost')).toBe(true);
    expect(container.querySelectorAll('[data-row]')).toHaveLength(16);
  });

  it('shows the cursors of the others in this pattern only', () => {
    editor.setPeers([
      { pattern: 0, row: 4, channel: 2, colour: '#f00', name: 'Ann' },
      { pattern: 1, row: 5, channel: 0, colour: '#0f0', name: 'Bob' },
    ]);
    expect(cellEl(4, 2).classList.contains('peer')).toBe(true);
    expect(container.querySelectorAll('.peer')).toHaveLength(1);
    editor.setPeers([]);
    expect(container.querySelector('.peer')).toBeNull();
  });

  it('scrolls the cursor into view, sideways too', () => {
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 50 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 60 });
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('c') ? Number(this.dataset.channel) * 60 + 20 : 0;
      },
    });
    editor.moveTo(0, 3);
    expect(container.scrollLeft).toBe(3 * 60 + 20 + 60 - 100);
    editor.moveTo(0, 0);
    expect(container.scrollLeft).toBe(20 - 60);
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetLeft;
  });

  it('draws nothing before it has a song, and an empty pattern for a missing one', () => {
    const fresh = new PatternEditor(document.createElement('div'));
    fresh.render();
    fresh.follow(0, 0);
    expect(fresh.container.children).toHaveLength(0);
    expect(fresh.pattern.rows).toBe(64);
    editor.show(song, 9);
    expect(container.querySelectorAll('.r')).toHaveLength(64);
  });
});
