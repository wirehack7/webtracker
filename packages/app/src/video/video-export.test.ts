// @vitest-environment happy-dom
import { createDemoSong } from '@webtracker/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordOptions } from './recorder.ts';
import { canExportVideo, exportVideo, readVideoTheme, type VideoHooks, type VideoSettings } from './video-export.ts';
import type { RecordedFrames, VideoReply, VideoRequest } from './video-worker.ts';

/**
 * How the page runs a video export: which way it picks, what it asks the
 * worker for and how it falls back. The worker and the recorder have their
 * own tests; here they are stand-ins that answer as told.
 */

const recordVideo = vi.hoisted(() => vi.fn());
vi.mock('./recorder.ts', async (original) => ({ ...(await original<typeof import('./recorder.ts')>()), recordVideo }));

class FakeWorker {
  static all: FakeWorker[] = [];
  /** The replies the next workers send, one list per worker. */
  static script: (VideoReply | 'crash')[][] = [];
  requests: VideoRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<VideoReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.all.push(this);
  }
  postMessage(request: VideoRequest) {
    this.requests.push(request);
    const replies = FakeWorker.script.shift() ?? [];
    queueMicrotask(() => {
      for (const reply of replies) {
        if (reply === 'crash') this.onerror?.(Object.assign(new Event('error'), { message: 'worker crashed' }) as ErrorEvent);
        else this.onmessage?.({ data: reply } as MessageEvent<VideoReply>);
      }
    });
  }
  terminate() {
    this.terminated = true;
  }
}

class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  closed = false;
  constructor(readonly options: AudioContextOptions) {
    FakeAudioContext.all.push(this);
  }
  async close() {
    this.closed = true;
  }
}

const song = createDemoSong();
const settings: VideoSettings = {
  song,
  title: '',
  name: 'tune',
  width: 1280,
  height: 720,
  fps: 30,
  container: 'mp4',
  beat: 4,
  bar: 16,
  muted: Array(song.channels).fill(false),
  resampler: 'linear',
  stereoSeparation: 100,
  volumeRamps: true,
  amplify: 100,
  karplusStrong: false,
};
const frames: RecordedFrames = { sampleRate: 48000, left: new Float32Array(96000), right: new Float32Array(96000), states: [], scopes: new Int8Array() };

let hooks: VideoHooks & { progress: number[]; recording: number };
let abort: AbortController;

function allowEncoding(on: boolean) {
  for (const name of ['VideoEncoder', 'AudioEncoder', 'OffscreenCanvas']) vi.stubGlobal(name, on ? class {} : undefined);
}
function allowRecording(on: boolean) {
  vi.stubGlobal('MediaRecorder', on ? class {} : undefined);
  vi.stubGlobal('AudioContext', on ? FakeAudioContext : undefined);
  HTMLCanvasElement.prototype.captureStream = on ? () => new MediaStream() : (undefined as never);
}

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.script = [];
  FakeAudioContext.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  allowEncoding(true);
  allowRecording(true);
  recordVideo.mockReset();
  recordVideo.mockResolvedValue({ blob: new Blob(['video']), extension: 'webm' });
  abort = new AbortController();
  hooks = {
    progress: [],
    recording: 0,
    onProgress: (f) => hooks.progress.push(f),
    onRecording: () => hooks.recording++,
    preview: document.createElement('div'),
    signal: abort.signal,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('video export', () => {
  it('reads the theme colours from the page, with a fallback for unset ones', () => {
    document.documentElement.style.setProperty('--pat-bg', ' #102030 ');
    const theme = readVideoTheme();
    expect(Object.values(theme)).toContain('#102030');
    expect(Object.values(theme)).toContain('#000');
  });

  it('is possible when the browser can encode or record', () => {
    expect(canExportVideo()).toBe(true);
    allowEncoding(false);
    expect(canExportVideo()).toBe(true);
    allowRecording(false);
    expect(canExportVideo()).toBe(false);
  });

  it('encodes in a worker and passes on its progress and file', async () => {
    const bytes = new Uint8Array([1, 2]);
    FakeWorker.script = [
      [
        { type: 'progress', fraction: 0.5 },
        { type: 'done', bytes, fileName: 'tune.mp4', seconds: 12, codecs: 'AVC + AAC' },
      ],
    ];
    const result = await exportVideo(settings, hooks);
    expect(result).toEqual({ data: bytes, fileName: 'tune.mp4', seconds: 12, codecs: 'AVC + AAC', recorded: false });
    expect(hooks.progress).toEqual([0.5]);
    const [worker] = FakeWorker.all;
    expect(worker!.options).toEqual({ type: 'module' });
    expect(worker!.url.pathname).toMatch(/video-worker\.ts$/);
    expect(worker!.terminated).toBe(true);
    const request = worker!.requests[0]!;
    expect(request).toMatchObject({ mode: 'encode', name: 'tune', width: 1280 });
    expect(request.fonts).toHaveLength(2);
    expect(request.fonts.every((f) => f.url.startsWith('http') && f.range.startsWith('U+'))).toBe(true);
    // No recording is planned, so no audio context is made.
    expect(FakeAudioContext.all).toEqual([]);
  });

  it('records in real time when the worker cannot encode, with the second half of the bar', async () => {
    FakeWorker.script = [[{ type: 'unsupported' }], [{ type: 'progress', fraction: 0.5 }, { type: 'frames', frames }]];
    recordVideo.mockImplementation(async (options: RecordOptions) => {
      options.onProgress(0.5);
      return { blob: new Blob(['video']), extension: 'mp4' };
    });
    const result = await exportVideo(settings, hooks);
    expect(result).toMatchObject({ fileName: 'tune.mp4', seconds: 2, codecs: '', recorded: true });
    expect(result.data).toBeInstanceOf(Blob);
    expect(hooks.recording).toBe(1);
    expect(hooks.progress).toEqual([0.25, 0.75]);
    expect(FakeWorker.all[1]!.requests[0]!.mode).toBe('frames');
    const options = recordVideo.mock.calls[0]![0] as RecordOptions;
    expect(options).toMatchObject({ frames, fps: 30, preview: hooks.preview });
    expect(options.painter).toMatchObject({ title: 'untitled', muted: settings.muted, beat: 4, bar: 16 });
    expect(options.painter.layout.width).toBe(1280);
    // The audio context made for the recording is closed after it.
    expect(FakeAudioContext.all).toHaveLength(1);
    expect(FakeAudioContext.all[0]!.options).toEqual({ sampleRate: 48000 });
    expect(FakeAudioContext.all[0]!.closed).toBe(true);
  });

  it('makes the audio context during the click when it will have to record', async () => {
    allowEncoding(false);
    FakeWorker.script = [[{ type: 'frames', frames }]];
    const running = exportVideo({ ...settings, title: 'Song' }, hooks);
    expect(FakeAudioContext.all).toHaveLength(1);
    await running;
    expect(FakeAudioContext.all).toHaveLength(1);
    expect(FakeWorker.all).toHaveLength(1);
    expect((recordVideo.mock.calls[0]![0] as RecordOptions).painter.title).toBe('Song');
  });

  it('fails when the browser can neither encode nor record', async () => {
    allowEncoding(false);
    allowRecording(false);
    await expect(exportVideo(settings, hooks)).rejects.toThrow('This browser can neither encode nor record video.');
    allowEncoding(true);
    FakeWorker.script = [[{ type: 'unsupported' }]];
    await expect(exportVideo(settings, hooks)).rejects.toThrow('This browser can neither encode nor record video.');
  });

  it('passes on the errors of the worker, and odd replies', async () => {
    FakeWorker.script = [[{ type: 'error', message: 'out of memory' }]];
    await expect(exportVideo(settings, hooks)).rejects.toThrow('out of memory');
    FakeWorker.script = [[{ type: 'frames', frames }]];
    await expect(exportVideo(settings, hooks)).rejects.toThrow('No video');
    FakeWorker.script = [['crash']];
    await expect(exportVideo(settings, hooks)).rejects.toThrow('worker crashed');
    expect(FakeWorker.all.at(-1)!.terminated).toBe(true);
    allowEncoding(false);
    FakeWorker.script = [[{ type: 'error', message: 'no song' }]];
    await expect(exportVideo(settings, hooks)).rejects.toThrow('no song');
    FakeWorker.script = [[{ type: 'unsupported' }]];
    await expect(exportVideo(settings, hooks)).rejects.toThrow('No frames');
    expect(FakeAudioContext.all.every((a) => a.closed)).toBe(true);
  });

  it('stops the worker when cancelled', async () => {
    FakeWorker.script = [[]];
    const running = exportVideo(settings, hooks);
    abort.abort();
    await expect(running).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });
});
