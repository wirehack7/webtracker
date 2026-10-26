// @vitest-environment happy-dom
import { createDemoSong, Player } from '@webtracker/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextOf, installDom } from '../test-dom.ts';
import { THEME_PROPERTIES, videoLayout, type VideoTheme } from './draw.ts';
import { SCOPE_POINTS } from './frames.ts';
import { canRecord, recordVideo, type RecordOptions } from './recorder.ts';
import type { RecordedFrames } from './video-worker.ts';

/**
 * Recording in real time. MediaRecorder, the media streams and the audio
 * context are stand-ins; the audio clock moves one video frame per
 * animation frame, so the test runs at once.
 */

class Track {
  stopped = false;
  constructor(readonly kind: string) {}
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  static last: FakeStream;
  constructor(readonly tracks: Track[]) {
    FakeStream.last = this;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeRecorder {
  static last: FakeRecorder;
  static supported: string[] = [];
  static isTypeSupported = (type: string) => FakeRecorder.supported.includes(type);
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  timeslice = 0;
  readonly mimeType: string;
  constructor(
    readonly stream: FakeStream,
    readonly options: MediaRecorderOptions,
  ) {
    this.mimeType = options.mimeType ?? '';
    FakeRecorder.last = this;
  }
  start(timeslice: number) {
    this.timeslice = timeslice;
  }
  stop() {
    this.ondataavailable!({ data: new Blob([]) });
    this.ondataavailable!({ data: new Blob(['frames']) });
    queueMicrotask(() => this.onstop!());
  }
}

const FPS = 10;

class FakeAudio {
  currentTime = 5;
  state = 'suspended';
  source = { buffer: null as unknown, connectedTo: null as unknown, startedAt: -1, stopped: false };
  buffer: { channels: number; length: number; rate: number; copied: Float32Array[] } | null = null;
  async resume() {
    this.state = 'running';
  }
  createBuffer(channels: number, length: number, rate: number) {
    this.buffer = { channels, length, rate, copied: [] };
    const buffer = this.buffer;
    return { copyToChannel: (data: Float32Array, c: number) => (buffer.copied[c] = data) };
  }
  createBufferSource() {
    const source = this.source;
    return {
      set buffer(b: unknown) {
        source.buffer = b;
      },
      connect: (d: unknown) => (source.connectedTo = d),
      start: (at: number) => (source.startedAt = at),
      stop: () => (source.stopped = true),
    };
  }
  createMediaStreamDestination() {
    return { stream: { getAudioTracks: () => [new Track('audio')] } };
  }
}

let audio: FakeAudio;
let frameCallbacks: number;

beforeEach(() => {
  installDom();
  FakeRecorder.supported = [];
  audio = new FakeAudio();
  frameCallbacks = 0;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('AudioContext', FakeAudio);
  HTMLCanvasElement.prototype.captureStream = function () {
    return { getVideoTracks: () => [new Track('video')] } as unknown as MediaStream;
  };
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: () => Promise.reject(new Error('offline')) } });
  // Each animation frame moves the audio clock on by one video frame.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameCallbacks++;
    setTimeout(() => {
      audio.currentTime += 1 / FPS;
      callback(0);
    }, 0);
    return frameCallbacks;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const song = createDemoSong();
const theme = Object.fromEntries(Object.keys(THEME_PROPERTIES).map((k) => [k, '#123456'])) as unknown as VideoTheme;

/** Five frames of a quiet song whose scopes are a ramp. */
function recorded(count = 5): RecordedFrames {
  const start = new Player(song, 48000).getState();
  const states = Array.from({ length: count }, (_, row) => ({ ...start, row }));
  const scopes = Int8Array.from({ length: count * song.channels * SCOPE_POINTS }, (_, i) => (i % 254) - 127);
  return { sampleRate: 48000, left: new Float32Array(count * 4800), right: new Float32Array(count * 4800), states, scopes };
}

function options(extra: Partial<RecordOptions> = {}): RecordOptions & { progress: number[] } {
  const progress: number[] = [];
  return {
    frames: recorded(),
    fps: FPS,
    audio: audio as unknown as AudioContext,
    preview: document.createElement('div'),
    onProgress: (f) => progress.push(f),
    signal: new AbortController().signal,
    painter: { song, title: 'Tune', theme, layout: videoLayout(640, 360, song.channels), muted: [], beat: 4, bar: 16 },
    progress,
    ...extra,
  };
}

describe('recorder', () => {
  it('can record where MediaRecorder, canvas capture and Web Audio exist', () => {
    expect(canRecord()).toBe(true);
    vi.stubGlobal('MediaRecorder', undefined);
    expect(canRecord()).toBe(false);
  });

  it('plays the audio and draws each frame while it records both', async () => {
    FakeRecorder.supported = ['video/webm;codecs=vp9,opus', 'video/webm'];
    const run = options();
    const recording = await recordVideo(run);
    expect(recording.extension).toBe('webm');
    expect(recording.blob.type).toBe('video/webm');
    expect(await recording.blob.text()).toBe('frames');
    // The canvas shows in the preview while it records, and is gone after.
    expect(run.preview.querySelector('canvas')).toBeNull();
    expect(FakeRecorder.last.options).toEqual({ mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: 6_000_000 });
    expect(FakeRecorder.last.timeslice).toBe(1000);
    expect(FakeStream.last.tracks.map((t) => [t.kind, t.stopped])).toEqual([
      ['video', true],
      ['audio', true],
    ]);
    expect(audio.state).toBe('running');
    expect(audio.buffer).toMatchObject({ channels: 2, length: 5 * 4800, rate: 48000 });
    expect(audio.buffer!.copied).toEqual([run.frames.left, run.frames.right]);
    expect(audio.source.startedAt).toBeCloseTo(5.1, 6);
    expect(audio.source.stopped).toBe(true);
    // Frame 0 is drawn at the start; the clock starts 0.1 s late, so frames 1 to 4 follow.
    expect(run.progress).toEqual([0.2, 0.4, 0.6, 0.8]);
  });

  it('draws the scopes from the packed values', async () => {
    const run = options({ frames: recorded(1) });
    run.painter = { ...run.painter, theme: { ...theme, scope: '#00ff00' } };
    const drawn: HTMLCanvasElement[] = [];
    run.preview.append = ((canvas: HTMLCanvasElement) => drawn.push(canvas)) as never;
    run.preview.replaceChildren = ((canvas: HTMLCanvasElement) => drawn.push(canvas)) as never;
    await recordVideo(run);
    const ctx = contextOf(drawn[0]!);
    expect(ctx.texts.some((t) => t.includes('Tune'))).toBe(true);
    // The ramp in the scopes draws columns at many heights, not a flat line.
    const tops = ctx.calls.filter((c) => c.op === 'fillRect' && c.style === '#00ff00').map((c) => c.args[1]);
    expect(new Set(tops).size).toBeGreaterThan(20);
  });

  it('prefers MP4, and takes what the browser gives when it names no type', async () => {
    FakeRecorder.supported = ['video/mp4'];
    expect((await recordVideo(options())).extension).toBe('mp4');
    expect(FakeRecorder.last.options.mimeType).toBe('video/mp4');
    FakeRecorder.supported = [];
    const recording = await recordVideo(options());
    expect(FakeRecorder.last.options).toEqual({ videoBitsPerSecond: 6_000_000 });
    expect(recording).toMatchObject({ extension: 'webm' });
    expect(recording.blob.type).toBe('video/webm');
  });

  it('stops and throws an AbortError when cancelled', async () => {
    const abort = new AbortController();
    const run = options({ signal: abort.signal });
    run.onProgress = (f) => {
      run.progress.push(f);
      abort.abort();
    };
    await expect(recordVideo(run)).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(run.progress).toEqual([0.2]);
    expect(audio.source.stopped).toBe(true);
    expect(FakeStream.last.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('records an empty song without failing', async () => {
    const run = options({ frames: { ...recorded(0), states: [] } });
    run.frames.states.push(recorded(1).states[0]!);
    await recordVideo(run);
    expect(audio.buffer!.length).toBe(1);
  });
});
