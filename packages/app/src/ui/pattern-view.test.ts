import { createSong, writeCell } from '@webtracker/engine';
import { describe, expect, it } from 'vitest';
import { Column, formatEffect, formatVolume, rowHtml } from './pattern-view.ts';

describe('pattern cell formatting', () => {
  it('formats the volume column', () => {
    expect(formatVolume(0)).toBe('..');
    expect(formatVolume(0x10)).toBe('00');
    expect(formatVolume(0x50)).toBe('40');
    expect(formatVolume(0x6f)).toBe('-F');
    expect(formatVolume(0xf3)).toBe('M3');
  });

  it('formats effects with XM letters', () => {
    expect(formatEffect(0, 0)).toBe('...');
    expect(formatEffect(0x0f, 0x7d)).toBe('F7D');
    expect(formatEffect(0x14, 0)).toBe('K00');
  });
});

describe('pattern rows', () => {
  const song = createSong(2);
  const pattern = song.patterns[0]!;
  writeCell(song, pattern, 3, 0, { note: 49, instrument: 0x1a, volume: 0x30, effect: 0x0c, param: 0x20 });

  /** The row as text, the way it shows: fields joined, channels split by '|'. */
  const text = (html: string) => html.replace(/<span class="c[^>]*>/g, '|').replace(/<[^>]+>/g, '');

  it('shows the row number and every field, with empty ones marked', () => {
    const html = rowHtml(song, pattern, 3);
    expect(text(html)).toBe('03|C-41A20C20|---.......');
    expect(html.match(/class="[nive x]+ empty"/g)).toHaveLength(5);
  });

  it('marks the cursor digit inside a two-digit field', () => {
    const html = rowHtml(song, pattern, 3, { row: 3, channel: 0, column: Column.InsLo, selection: null });
    expect(html).toContain('<span class="c at" data-channel="0">');
    expect(html).toContain('<span class="i"><span data-col="1">1</span><span data-col="2" class="k">A</span></span>');
    const onNote = rowHtml(song, pattern, 3, { row: 3, channel: 0, column: Column.Note, selection: null });
    expect(onNote).toContain('<span class="n k" data-col="0">C-4</span>');
    const onEffect = rowHtml(song, pattern, 3, { row: 3, channel: 0, column: Column.Effect, selection: null });
    expect(onEffect).toContain('<span class="e k" data-col="5">C</span>');
  });

  it('marks the selection and other people\'s cursors, escaping their names', () => {
    const html = rowHtml(song, pattern, 3, {
      row: 0,
      channel: 0,
      column: 0,
      selection: { row0: 2, row1: 4, ch0: 1, ch1: 1 },
      peers: [{ pattern: 0, row: 3, channel: 0, colour: '#f00', name: 'Tom & "Jerry" <3' }],
    });
    expect(html).toContain('<span class="c peer" style="--peer: #f00" title="Tom &amp; &quot;Jerry&quot; &lt;3" data-channel="0">');
    expect(html).toContain('<span class="c sel" data-channel="1">');
    expect(rowHtml(song, pattern, 5, { row: 0, channel: 0, column: 0, selection: { row0: 2, row1: 4, ch0: 0, ch1: 1 } })).not.toContain('sel');
  });

  it('shows unknown volume commands and effects as ?', () => {
    expect(formatVolume(0xff + 0x10)).toBe('?F');
    expect(formatEffect(40, 1)).toBe('?01');
  });
});
