import { createDemoSong, createSong, writeCell, type Song } from '@webtracker/engine';
import { unzipAll } from '@webtracker/formats';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AudioFormat } from './audio-format.ts';
import type { ExportReply, ExportRequest } from './export-worker.ts';

/** The export worker, run in-process: the test posts a request and reads the replies. */

let replies: { message: ExportReply; transfer?: Transferable[] | undefined }[];
const scope = {
  onmessage: null as ((event: MessageEvent<ExportRequest>) => Promise<void>) | null,
  postMessage: (message: ExportReply, transfer?: Transferable[]) => replies.push({ message, transfer }),
};

beforeAll(async () => {
  (globalThis as Record<string, unknown>).self = scope;
  await import('./export-worker.ts');
});

beforeEach(() => {
  replies = [];
});

/** The demo song cut to one order, so it renders quickly. */
function short(): Song {
  const song = createDemoSong();
  song.orders = song.orders.slice(0, 1);
  return song;
}

async function exportSong(format: AudioFormat, extra: Partial<ExportRequest> = {}) {
  const song = extra.song ?? short();
  await scope.onmessage!({
    data: {
      song,
      format,
      sampleRate: 22050,
      stems: false,
      muted: Array(song.channels).fill(false),
      resampler: 'linear',
      stereoSeparation: 100,
      volumeRamps: true,
      amplify: 100,
      karplusStrong: false,
      name: 'tune',
      ...extra,
    },
  } as MessageEvent<ExportRequest>);
  const progress = replies.filter((r) => r.message.type === 'progress').map((r) => (r.message as { fraction: number }).fraction);
  return { last: replies.at(-1)!, progress };
}

describe('export worker', () => {
  it('renders the mix to WAV, with rising progress, and hands over the bytes', async () => {
    const { last, progress } = await exportSong({ kind: 'wav', format: 'pcm16' });
    expect(last.message).toMatchObject({ type: 'done', fileName: 'tune.wav' });
    const done = last.message as Extract<ExportReply, { type: 'done' }>;
    expect(last.transfer).toEqual([done.bytes.buffer]);
    const view = new DataView(done.bytes.buffer);
    expect(new TextDecoder().decode(done.bytes.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(22050);
    // 16-bit stereo after a 44-byte header.
    expect(done.seconds).toBeCloseTo((done.bytes.length - 44) / 4 / 22050, 6);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBeLessThanOrEqual(1);
  });

  it('writes FLAC and MP3, the MP3 at a rate it supports', async () => {
    const flac = await exportSong({ kind: 'flac', depth: 16 });
    expect(flac.last.message).toMatchObject({ type: 'done', fileName: 'tune.flac' });
    expect(new TextDecoder().decode((flac.last.message as { bytes: Uint8Array }).bytes.subarray(0, 4))).toBe('fLaC');
    replies = [];
    const mp3 = await exportSong({ kind: 'mp3', kbps: 128 }, { sampleRate: 96000 });
    expect(mp3.last.message).toMatchObject({ type: 'done', fileName: 'tune.mp3' });
    // Half the progress is rendering, half encoding.
    expect(mp3.progress.some((f) => f > 0.5)).toBe(true);
  });

  it('puts one file per sounding channel next to the mix in a ZIP', async () => {
    const song = createSong(4);
    const demo = short();
    song.instruments = demo.instruments;
    song.orders = [0];
    writeCell(song, song.patterns[0]!, 0, 1, { note: 49, instrument: 1 });
    writeCell(song, song.patterns[0]!, 0, 3, { note: 37, instrument: 1 });
    song.title = '  ';
    const { last, progress } = await exportSong({ kind: 'wav', format: 'pcm16' }, { song, stems: true });
    expect(last.message).toMatchObject({ type: 'done', fileName: 'tune stems.zip' });
    const names = unzipAll((last.message as { bytes: Uint8Array }).bytes).map((e) => e.name);
    expect(names).toEqual(['tune.wav', 'tune - channel 02.wav', 'tune - channel 04.wav']);
    // Five passes: the mix and four channels.
    expect(progress.at(-1)).toBeGreaterThan(0.8);
  });

  it('reports errors as a message', async () => {
    const { last } = await exportSong({ kind: 'wav', format: 'pcm16' }, { song: { ...short(), orders: null } as unknown as Song });
    expect(last.message.type).toBe('error');
    expect((last.message as { message: string }).message.length).toBeGreaterThan(0);
  });
});
