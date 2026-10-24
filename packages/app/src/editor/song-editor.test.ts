import { describe, expect, it } from 'vitest';
import { createSong, readCell, resizePattern, writeCell } from '@webtracker/engine';
import type { EngineMessage } from '../audio/messages.ts';
import { SongEditor } from './song-editor.ts';

function setup() {
  const sent: EngineMessage[] = [];
  const editor = new SongEditor(createSong(4), (m) => sent.push(m));
  return { editor, sent };
}

describe('SongEditor', () => {
  it('edits a pattern, syncs it and undoes it', () => {
    const { editor, sent } = setup();
    editor.editPattern(0, 'note', (p) => writeCell(editor.song, p, 2, 1, { note: 49, instrument: 1 }));
    expect(readCell(editor.song, editor.song.patterns[0]!, 2, 1).note).toBe(49);
    expect(sent.at(-1)).toMatchObject({ type: 'pattern', index: 0 });
    expect(editor.dirty).toBe(true);

    expect(editor.undo()).toBe('note');
    expect(readCell(editor.song, editor.song.patterns[0]!, 2, 1).note).toBe(0);
    expect(editor.redo()).toBe('note');
    expect(readCell(editor.song, editor.song.patterns[0]!, 2, 1).note).toBe(49);
  });

  it('does not record edits that change nothing', () => {
    const { editor, sent } = setup();
    editor.editPattern(0, 'nothing', () => {});
    expect(sent).toHaveLength(0);
    expect(editor.undo()).toBeNull();
  });

  it('undoes a resize back to the old length and content', () => {
    const { editor } = setup();
    editor.editPattern(0, 'note', (p) => writeCell(editor.song, p, 50, 0, { note: 49 }));
    editor.editPattern(0, 'length', (p) => resizePattern(editor.song, p, 32));
    expect(editor.song.patterns[0]!.rows).toBe(32);
    editor.undo();
    expect(editor.song.patterns[0]!.rows).toBe(64);
    expect(readCell(editor.song, editor.song.patterns[0]!, 50, 0).note).toBe(49);
  });

  it('creates patterns the order list points to and sends them', () => {
    const { editor, sent } = setup();
    editor.editOrders('order', (o) => [...o, 2]);
    expect(editor.song.patterns).toHaveLength(3);
    expect(sent.filter((m) => m.type === 'pattern').map((m) => (m.type === 'pattern' ? m.index : -1))).toEqual([1, 2]);
    expect(sent.at(-1)).toEqual({ type: 'orders', orders: [0, 2], restartPosition: 0 });
    editor.undo();
    expect(editor.song.orders).toEqual([0]);
  });

  it('never leaves the order list empty', () => {
    const { editor } = setup();
    editor.editOrders('delete', () => []);
    expect(editor.song.orders).toEqual([0]);
  });

  it('a new song clears the history', () => {
    const { editor, sent } = setup();
    editor.editPattern(0, 'note', (p) => writeCell(editor.song, p, 0, 0, { note: 49 }));
    editor.replaceSong(createSong(8));
    expect(editor.undo()).toBeNull();
    expect(editor.dirty).toBe(false);
    expect(sent.at(-1)?.type).toBe('load');
  });
});
