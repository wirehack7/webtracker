import { describe, expect, it } from 'vitest';
import { cleanupSong, createSong, readCell, resizePattern, writeCell } from '@webtracker/engine';
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

  it('edits several patterns as one undo step', () => {
    const { editor } = setup();
    editor.editPatterns([0, 1, 1], 'song edit', (p) => writeCell(editor.song, p, 0, 0, { note: 49 }));
    expect(readCell(editor.song, editor.song.patterns[1]!, 0, 0).note).toBe(49);
    expect(editor.undo()).toBe('song edit');
    expect(readCell(editor.song, editor.song.patterns[0]!, 0, 0).note).toBe(0);
    expect(readCell(editor.song, editor.song.patterns[1]!, 0, 0).note).toBe(0);
    expect(editor.undo()).toBeNull();
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

describe('SongEditor song settings', () => {
  it('changes the channel count, reloads the player and undoes it', () => {
    const { editor, sent } = setup();
    editor.editPattern(0, 'note', (p) => writeCell(editor.song, p, 0, 3, { note: 49, instrument: 1 }));
    editor.setChannels(2);
    expect(editor.song.channels).toBe(2);
    expect(editor.song.patterns[0]!.data.length).toBe(64 * 2 * 5);
    expect(sent.at(-1)).toMatchObject({ type: 'load' });
    expect(editor.undo()).toBe('channels');
    expect(editor.song.channels).toBe(4);
    expect(readCell(editor.song, editor.song.patterns[0]!, 0, 3).note).toBe(49);
  });

  it('cleans up the song as one undo step and reloads the player', () => {
    const { editor, sent } = setup();
    editor.editOrders('orders', () => [0, 2]);
    writeCell(editor.song, editor.song.patterns[2]!, 0, 0, { note: 49, instrument: 3 });
    const instruments = editor.song.instruments.length;
    editor.editSong('clean up', (s) => cleanupSong(s, { unusedPatterns: true, duplicatePatterns: false, unusedInstruments: true, compactInstruments: true, unusedSamples: false, sampleTails: false }));
    expect(editor.song.patterns).toHaveLength(2);
    expect(editor.song.orders).toEqual([0, 1]);
    expect(readCell(editor.song, editor.song.patterns[1]!, 0, 0).instrument).toBe(1);
    expect(sent.at(-1)).toMatchObject({ type: 'load' });

    expect(editor.undo()).toBe('clean up');
    expect(editor.song.patterns).toHaveLength(3);
    expect(editor.song.orders).toEqual([0, 2]);
    expect(editor.song.instruments).toHaveLength(instruments);
    expect(readCell(editor.song, editor.song.patterns[2]!, 0, 0).instrument).toBe(3);
  });

  it('sets the title, cut to 20 characters, with undo', () => {
    const { editor } = setup();
    editor.setTitle('a very long song title indeed');
    expect(editor.song.title).toBe('a very long song tit');
    editor.undo();
    expect(editor.song.title).toBe('');
  });
});

describe('SongEditor instruments', () => {
  it('edits an instrument, syncs it and undoes it', () => {
    const { editor, sent } = setup();
    editor.editInstrument(0, 'volume', (ins) => {
      ins.samples[0]!.volume = 10;
      ins.samples[0]!.data[0] = 0;
    });
    expect(sent.at(-1)).toMatchObject({ type: 'instrument', index: 0 });
    editor.undo();
    expect(editor.song.instruments[0]!.samples[0]!.volume).toBe(48);
    expect(editor.song.instruments[0]!.samples[0]!.data[0]).not.toBe(0);
  });

  it('adds empty instruments up to the one edited', () => {
    const { editor } = setup();
    editor.editInstrument(9, 'name', (ins) => {
      ins.name = 'lead';
    });
    expect(editor.song.instruments).toHaveLength(10);
    expect(editor.song.instruments[9]!.name).toBe('lead');
  });

  it('records a drag as one step', () => {
    const { editor } = setup();
    const before = editor.snapshotInstrument(0);
    const ins = editor.song.instruments[0]!;
    for (let i = 1; i <= 5; i++) {
      ins.fadeout = i * 100;
      editor.previewInstrument(0);
    }
    editor.recordInstrument(0, 'drag', before);
    editor.undo();
    expect(editor.song.instruments[0]!.fadeout).toBe(0);
    expect(editor.undo()).toBeNull();
  });

  it('skips instrument edits that change nothing', () => {
    const { editor } = setup();
    editor.editInstrument(0, 'nothing', () => {});
    expect(editor.undo()).toBeNull();
  });
});
