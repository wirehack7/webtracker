// The Song stats dialog: play time, what each part takes in the saved file,
// what the song never plays, and an optimizer that makes the module smaller
// for demos and intros. Optimizing is one undoable edit.

import { cleanedCopy, songDuration, type CleanupOptions, type CleanupResult, type Song } from '@webtracker/engine';
import { saveMod, saveXm, songStats, type SongStats } from '@webtracker/formats';
import { language, msg, t } from '../i18n/i18n.ts';

/** Bytes as people read them: bytes below 1 KB, then KB with one decimal. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return t('{count} B', { count: bytes.toLocaleString(language()) });
  return t('{size} KB', { size: (bytes / 1024).toLocaleString(language(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }) });
}

export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** What an optimization changes, as a list for a sentence; empty when nothing. */
export function describeCleanup(result: CleanupResult): string {
  const count = (n: number, one: string, many: string) => (n ? [t(n === 1 ? one : many, { count: n })] : []);
  const parts = [
    ...count(result.patterns, msg('{count} pattern removed'), msg('{count} patterns removed')),
    ...count(result.instruments, msg('{count} instrument removed'), msg('{count} instruments removed')),
    ...count(result.samples, msg('{count} sample removed'), msg('{count} samples removed')),
    ...count(result.halved, msg('{count} sample at half rate'), msg('{count} samples at half rate')),
    ...count(result.converted, msg('{count} sample to 8-bit'), msg('{count} samples to 8-bit')),
  ];
  if (result.frames) parts.push(t('{count} sample frames fewer', { count: result.frames.toLocaleString(language()) }));
  return parts.join(', ');
}

/** The song as the format it is saved in by default: MOD stays MOD. */
const savedBytes = (song: Song): Uint8Array => (song.format === 'mod' ? saveMod(song).bytes : saveXm(song));

/** Deflate is what zip and most intro packers build on, so its size is a fair estimate. */
async function deflatedSize(bytes: Uint8Array): Promise<number> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

function cell(tag: 'td' | 'th', text: string, className = ''): HTMLTableCellElement {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function row(cells: HTMLTableCellElement[], className = ''): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (className) tr.className = className;
  tr.append(...cells);
  return tr;
}

/** A header row; columns from `numbers` on, up to the last, hold numbers. */
const head = (numbers: number, ...labels: string[]) => row(labels.map((label, i) => cell('th', label, i >= numbers && i < labels.length - 1 ? 'num' : '')));

export interface SongStatsDialog {
  open(): void;
}

export interface SongStatsHost {
  song(): Song;
  /** Runs the optimization as one undoable edit and returns what it changed. */
  optimize(options: CleanupOptions): CleanupResult;
}

export function mountSongStats(dialog: HTMLDialogElement, host: SongStatsHost): SongStatsDialog {
  const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const summary = $<HTMLTableElement>('#stats-summary');
  const samples = $<HTMLTableElement>('#stats-samples');
  const patterns = $<HTMLTableElement>('#stats-patterns');
  const info = $('#stats-info');
  const box = (id: string) => $<HTMLInputElement>(id);
  const halve = box('#cu-halve');
  // Bumped on every refresh and preview, so late async results for an older state are dropped.
  let opened = 0;
  let previewed = 0;

  const options = (): CleanupOptions => ({
    unusedPatterns: box('#cu-patterns').checked,
    duplicatePatterns: box('#cu-duplicates').checked,
    unusedInstruments: box('#cu-instruments').checked,
    compactInstruments: box('#cu-compact').checked,
    unusedSamples: box('#cu-samples').checked,
    sampleTails: box('#cu-tails').checked,
    halveRate: halve.checked && !halve.disabled,
    eightBit: box('#cu-8bit').checked,
  });

  function showSummary(song: Song, stats: SongStats): void {
    const used = (n: number, of: number) => t('{used} used of {total}', { used: n, total: of });
    const allSamples = stats.instruments.flatMap((i) => i.samples);
    const lines: [string, string, string?][] = [
      [t('Play time'), t('counting…'), 'stats-time'],
      [t('Positions'), String(song.orders.length)],
      [t('Patterns'), used(stats.patterns.filter((p) => p.positions).length, stats.patterns.length)],
      [t('Instruments'), used(stats.instruments.filter((i) => i.used).length, stats.instruments.length)],
      [t('Samples'), used(allSamples.filter((s) => s.used).length, allSamples.length)],
      [t('Saved as XM'), formatBytes(stats.xm)],
      [
        t('In the XM file'),
        t('patterns {patterns}, samples {samples}, headers {headers}', {
          patterns: formatBytes(stats.patternBytes),
          samples: formatBytes(stats.sampleBytes),
          headers: formatBytes(stats.header + stats.instrumentBytes),
        }),
      ],
      [t('Saved as MOD'), stats.mod.lossy ? t('{size}, leaves out what MOD lacks', { size: formatBytes(stats.mod.bytes) }) : formatBytes(stats.mod.bytes)],
      [t('Packed'), t('counting…'), 'stats-packed'],
    ];
    summary.replaceChildren(...lines.map(([label, value, id]) => {
      const td = cell('td', value);
      if (id) td.id = id;
      return row([cell('th', label), td]);
    }));
  }

  function showSamples(stats: SongStats): void {
    const rows = [head(2, t('Ins'), t('Name'), t('Length'), t('Bits'), t('Size'), '')];
    for (const ins of stats.instruments) {
      rows.push(row([cell('td', hex2(ins.number)), cell('td', ins.name), cell('td', ''), cell('td', ''), cell('td', formatBytes(ins.bytes), 'num'), cell('td', ins.used ? '' : t('unused'))], ins.used ? 'ins' : 'ins unused'));
      for (const s of ins.samples) {
        const notes = [...(ins.used && !s.used ? [t('no note reaches it')] : []), ...(s.tail ? [t('{count} frames after the loop', { count: s.tail.toLocaleString(language()) })] : [])];
        rows.push(
          row(
            [
              cell('td', ''),
              cell('td', s.name || t('Sample {n}', { n: s.index }), 'sub'),
              cell('td', s.frames.toLocaleString(language()), 'num'),
              cell('td', String(s.bits), 'num'),
              cell('td', formatBytes(s.bytes), 'num'),
              cell('td', notes.join(', ')),
            ],
            s.used ? '' : 'unused',
          ),
        );
      }
    }
    samples.replaceChildren(...rows);
  }

  function showPatterns(stats: SongStats): void {
    patterns.replaceChildren(
      head(1, t('Pat'), t('Rows'), t('Plays'), t('Size'), ''),
      ...stats.patterns.map((p) =>
        row(
          [cell('td', hex2(p.index)), cell('td', String(p.rows), 'num'), cell('td', String(p.positions), 'num'), cell('td', formatBytes(p.bytes), 'num'), cell('td', p.positions ? '' : t('unused'))],
          p.positions ? '' : 'unused',
        ),
      ),
    );
  }

  async function preview(): Promise<void> {
    const song = host.song();
    const current = ++previewed;
    const { song: optimized, result } = cleanedCopy(song, options());
    const what = describeCleanup(result);
    if (!what) {
      info.textContent = t('Optimize: nothing to change.');
      return;
    }
    const before = savedBytes(song);
    const after = savedBytes(optimized);
    const format = song.format === 'mod' ? 'MOD' : 'XM';
    info.textContent = t('Optimize would change: {what}. {format} file from {before} to {after}.', { what, format, before: formatBytes(before.length), after: formatBytes(after.length) });
    const [packedBefore, packedAfter] = await Promise.all([deflatedSize(before), deflatedSize(after)]);
    if (current !== previewed) return;
    info.textContent += ' ' + t('Packed from {before} to {after}.', { before: formatBytes(packedBefore), after: formatBytes(packedAfter) });
  }

  function refresh(withPreview: boolean): void {
    const current = ++opened;
    const song = host.song();
    const stats = songStats(song);
    // MOD periods stop at the Amiga's range, so an octave down does not play back right.
    halve.disabled = song.format === 'mod';
    showSummary(song, stats);
    showSamples(stats);
    showPatterns(stats);
    previewed++;
    if (withPreview) void preview();
    // Timing plays the whole song, so it comes after the dialog has drawn.
    setTimeout(() => {
      if (current !== opened) return;
      const { seconds, endless } = songDuration(song);
      $('#stats-time').textContent = endless ? t('over {time}, never ends', { time: formatDuration(seconds) }) : formatDuration(seconds);
    });
    void deflatedSize(saveXm(song)).then((bytes) => {
      if (current === opened) $('#stats-packed').textContent = t('about {size} as a deflated XM', { size: formatBytes(bytes) });
    });
  }

  for (const input of dialog.querySelectorAll<HTMLInputElement>('.stats-optimize input')) {
    input.addEventListener('change', () => void preview());
  }
  $('#cu-go').addEventListener('click', () => {
    const chosen = options();
    if (!describeCleanup(cleanedCopy(host.song(), chosen).result)) {
      info.textContent = t('Optimize: nothing to change.');
      return;
    }
    const before = savedBytes(host.song()).length;
    const result = host.optimize(chosen);
    refresh(false);
    info.textContent = t('Optimized: {what}. From {before} to {after}; Ctrl+Z undoes it.', {
      what: describeCleanup(result),
      before: formatBytes(before),
      after: formatBytes(savedBytes(host.song()).length),
    });
  });

  return {
    open() {
      refresh(true);
      dialog.showModal();
    },
  };
}
