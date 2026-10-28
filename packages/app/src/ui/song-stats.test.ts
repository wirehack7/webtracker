// @vitest-environment happy-dom
import { cleanedCopy, createDemoSong, type CleanupOptions, type Song } from '@webtracker/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, loadPage } from '../test-dom.ts';
import { describeCleanup, formatBytes, formatDuration, mountSongStats } from './song-stats.ts';

describe('song stats', () => {
  it('formats sizes and times', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2560)).toBe('2.5 KB');
    expect(formatDuration(61.6)).toBe('1:02');
    expect(formatDuration(5)).toBe('0:05');
  });

  it('describes what an optimization changes', () => {
    expect(describeCleanup({ patterns: 0, instruments: 0, samples: 0, frames: 0, halved: 0, converted: 0 })).toBe('');
    expect(describeCleanup({ patterns: 1, instruments: 2, samples: 0, frames: 1500, halved: 1, converted: 3 })).toBe(
      '1 pattern removed, 2 instruments removed, 1 sample at half rate, 3 samples to 8-bit, 1,500 sample frames fewer',
    );
  });
});

describe('the Song stats dialog', () => {
  let song: Song;
  const optimized: CleanupOptions[] = [];

  beforeEach(async () => {
    installDom();
    await loadPage('index.html', '#stats-dialog');
    // The demo with one pattern and one instrument that never play.
    song = createDemoSong();
    song.patterns.push({ rows: 16, data: new Uint8Array(16 * song.channels * 5) });
    song.instruments.push({ ...song.instruments[0]!, name: 'Spare' });
    optimized.length = 0;
  });

  function mount() {
    const dialog = document.querySelector<HTMLDialogElement>('#stats-dialog')!;
    const stats = mountSongStats(dialog, {
      song: () => song,
      optimize(options) {
        optimized.push(options);
        const { song: next, result } = cleanedCopy(song, options);
        song = next;
        return result;
      },
    });
    const text = (selector: string) => dialog.querySelector(selector)!.textContent ?? '';
    const rows = (selector: string) => [...dialog.querySelectorAll(`${selector} tr`)].map((tr) => [...tr.children].map((c) => c.textContent));
    return { dialog, stats, text, rows };
  }

  const summary = (rows: (string | null)[][]) => Object.fromEntries(rows.map(([k, v]) => [k, v]));

  it('lists play time, sizes, instruments and patterns, and marks what never plays', async () => {
    const { dialog, stats, text, rows } = mount();
    stats.open();
    expect(dialog.open).toBe(true);
    const first = summary(rows('#stats-summary'));
    expect(first['Positions']).toBe(String(song.orders.length));
    expect(first['Patterns']).toBe(`${song.patterns.length - 1} used of ${song.patterns.length}`);
    // The demo carries instruments it does not play, besides the spare one.
    expect(first['Instruments']).toMatch(new RegExp(`^\\d+ used of ${song.instruments.length}$`));
    expect(first['Saved as XM']).toMatch(/ KB$/);
    expect(first['Play time']).toBe('counting…');
    // Play time and the packed size come in after the dialog is drawn.
    await vi.waitFor(() => expect(text('#stats-time')).toMatch(/^\d+:\d\d$/));
    await vi.waitFor(() => expect(text('#stats-packed')).toMatch(/^about [\d.]+ KB as a deflated XM$/));

    const samples = rows('#stats-samples');
    expect(samples[0]).toEqual(['Ins', 'Name', 'Length', 'Bits', 'Size', '']);
    const spare = samples.find((r) => r[1] === 'Spare')!;
    expect(spare.at(-1)).toBe('unused');
    const patterns = rows('#stats-patterns');
    expect(patterns[0]).toEqual(['Pat', 'Rows', 'Plays', 'Size', '']);
    const last = (song.patterns.length - 1).toString(16).toUpperCase().padStart(2, '0');
    expect(patterns.at(-1)).toEqual([last, '16', '0', expect.stringMatching(/ B$/), 'unused']);
    // The preview says what Optimize would do, then how much smaller it packs.
    await vi.waitFor(() => expect(text('#stats-info')).toMatch(/^Optimize would change: 1 pattern removed, \d+ instruments removed.*XM file from .* to .*\. Packed from .* to .*\.$/));
  });

  it('previews again when an option changes, and says when there is nothing to do', async () => {
    const { dialog, stats, text } = mount();
    stats.open();
    for (const box of dialog.querySelectorAll<HTMLInputElement>('.stats-optimize input')) {
      box.checked = false;
      box.dispatchEvent(new Event('change'));
    }
    await vi.waitFor(() => expect(text('#stats-info')).toBe('Optimize: nothing to change.'));
    dialog.querySelector<HTMLButtonElement>('#cu-go')!.click();
    expect(optimized).toEqual([]);
    expect(text('#stats-info')).toBe('Optimize: nothing to change.');
  });

  it('optimizes as one edit and shows the smaller song', async () => {
    const { dialog, stats, text, rows } = mount();
    stats.open();
    dialog.querySelector<HTMLButtonElement>('#cu-go')!.click();
    expect(optimized).toHaveLength(1);
    expect(optimized[0]).toMatchObject({ unusedPatterns: true, unusedInstruments: true, halveRate: false });
    expect(text('#stats-info')).toMatch(/^Optimized: 1 pattern removed, \d+ instruments removed.*\. From .* to .*; Ctrl\+Z undoes it\.$/);
    const after = summary(rows('#stats-summary'));
    expect(after['Patterns']).toBe(`${song.patterns.length} used of ${song.patterns.length}`);
    // A second run finds nothing more.
    dialog.querySelector<HTMLButtonElement>('#cu-go')!.click();
    expect(text('#stats-info')).toBe('Optimize: nothing to change.');
  });

  it('keeps MOD songs at their sample rate and saves them as MOD', async () => {
    song.format = 'mod';
    const { dialog, stats, rows } = mount();
    const halve = dialog.querySelector<HTMLInputElement>('#cu-halve')!;
    halve.checked = true;
    stats.open();
    expect(halve.disabled).toBe(true);
    expect(summary(rows('#stats-summary'))['Saved as MOD']).toMatch(/ (K?B)/);
    dialog.querySelector<HTMLButtonElement>('#cu-go')!.click();
    expect(optimized[0]!.halveRate).toBe(false);
  });
});
