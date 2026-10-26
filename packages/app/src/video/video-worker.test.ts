// @vitest-environment happy-dom
import { createDemoSong, type Song } from '@webtracker/engine';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingContext } from '../test-dom.ts';
import { THEME_PROPERTIES, type VideoTheme } from './draw.ts';
import { SCOPE_POINTS, VIDEO_SAMPLE_RATE } from './frames.ts';
import type { VideoReply, VideoRequest } from './video-worker.ts';

/**
 * The video worker, run in-process. The frames for the recorder are real;
 * for encoding, Mediabunny and WebCodecs are stand-ins that record what the
 * worker gives them, since Node has no video encoder. That a browser's
 * encoder makes a playable file is left to trying it in the browser.
 */

const media = vi.hoisted(() => ({
  /** Codecs this pretend browser cannot encode. */
  missing: new Set<string>(),
  outputs: [] as { format: string; tags: unknown; video: number[]; audio: { timestamp: number; frames: number }[]; finalized: boolean }[],
}));

vi.mock('mediabunny', () => {
  class Format {
    constructor(readonly name: string) {}
  }
  class CanvasSource {
    readonly times: number[] = [];
    constructor(
      readonly canvas: unknown,
      readonly options: unknown,
    ) {}
    async add(time: number) {
      this.times.push(time);
    }
  }
  class AudioSampleSource {
    readonly samples: { timestamp: number; frames: number }[] = [];
    constructor(readonly options: unknown) {}
    async add(sample: { timestamp: number; data: Float32Array }) {
      this.samples.push({ timestamp: sample.timestamp, frames: sample.data.length / 2 });
    }
  }
  return {
    QUALITY_HIGH: 'high',
    QUALITY_MEDIUM: 'medium',
    Mp4OutputFormat: class extends Format {
      constructor() {
        super('mp4');
      }
    },
    WebMOutputFormat: class extends Format {
      constructor() {
        super('webm');
      }
    },
    BufferTarget: class {
      buffer: ArrayBuffer | null = null;
    },
    CanvasSource,
    AudioSampleSource,
    AudioSample: class {
      closed = false;
      constructor(readonly init: { data: Float32Array; timestamp: number }) {}
      get timestamp() {
        return this.init.timestamp;
      }
      get data() {
        return this.init.data;
      }
      close() {
        this.closed = true;
      }
    },
    Output: class {
      record = { format: '', tags: null as unknown, video: [] as number[], audio: [] as { timestamp: number; frames: number }[], finalized: false };
      video: CanvasSource | null = null;
      audio: AudioSampleSource | null = null;
      constructor(readonly options: { format: Format; target: { buffer: ArrayBuffer | null } }) {
        this.record.format = options.format.name;
        media.outputs.push(this.record);
      }
      addVideoTrack(source: CanvasSource) {
        this.video = source;
      }
      addAudioTrack(source: AudioSampleSource) {
        this.audio = source;
      }
      setMetadataTags(tags: unknown) {
        this.record.tags = tags;
      }
      async start() {}
      async finalize() {
        this.record.video = this.video!.times;
        this.record.audio = this.audio!.samples;
        this.record.finalized = true;
        this.options.target.buffer = new Uint8Array([1, 2, 3]).buffer;
      }
    },
    getFirstEncodableVideoCodec: async (codecs: string[]) => codecs.find((c) => !media.missing.has(c)) ?? null,
    getFirstEncodableAudioCodec: async (codecs: string[]) => codecs.find((c) => !media.missing.has(c)) ?? null,
  };
});

let replies: { message: VideoReply; transfer?: Transferable[] | undefined }[];
const scope = {
  onmessage: null as ((event: MessageEvent<VideoRequest>) => Promise<void>) | null,
  postMessage: (message: VideoReply, transfer?: Transferable[]) => replies.push({ message, transfer }),
  fonts: undefined as { add(face: unknown): void } | undefined,
};

beforeAll(async () => {
  vi.stubGlobal('self', scope);
  await import('./video-worker.ts');
});

let fonts: unknown[];

beforeEach(() => {
  replies = [];
  fonts = [];
  media.missing.clear();
  media.outputs = [];
  scope.fonts = { add: (face) => fonts.push(face) };
  vi.stubGlobal('VideoEncoder', class {});
  vi.stubGlobal('AudioEncoder', class {});
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return new RecordingContext(this as unknown as HTMLCanvasElement);
      }
    },
  );
  vi.stubGlobal(
    'FontFace',
    class {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly options: FontFaceDescriptors,
      ) {}
      async load() {
        if (this.source.includes('missing')) throw new Error('404');
        return this;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('self', scope);
});

/** The demo song cut to its first 16 rows, about two seconds. */
function short(): Song {
  const song = createDemoSong();
  song.orders = [0];
  song.patterns[song.orders[0]!]!.rows = 16;
  return song;
}

const theme = Object.fromEntries(Object.keys(THEME_PROPERTIES).map((k) => [k, '#123456'])) as unknown as VideoTheme;

async function send(mode: VideoRequest['mode'], extra: Partial<VideoRequest> = {}) {
  const song = extra.song ?? short();
  await scope.onmessage!({
    data: {
      mode,
      song,
      title: 'Tune',
      name: 'tune',
      width: 640,
      height: 360,
      fps: 10,
      container: 'mp4',
      theme,
      beat: 4,
      bar: 16,
      fonts: [{ url: 'https://example.org/font.woff2', range: 'U+0000-00FF' }],
      muted: Array(song.channels).fill(false),
      resampler: 'linear',
      stereoSeparation: 100,
      volumeRamps: true,
      amplify: 100,
      karplusStrong: false,
      ...extra,
    },
  } as MessageEvent<VideoRequest>);
  return replies.at(-1)!;
}

describe('video worker', () => {
  it('hands the recorder the audio, rows and packed scopes of every frame', async () => {
    const song = short();
    const last = await send('frames', { song });
    expect(last.message.type).toBe('frames');
    const { frames } = last.message as Extract<VideoReply, { type: 'frames' }>;
    const count = frames.states.length;
    expect(frames.sampleRate).toBe(VIDEO_SAMPLE_RATE);
    expect(frames.left.length).toBe(frames.right.length);
    expect(frames.left.length).toBeCloseTo((count * VIDEO_SAMPLE_RATE) / 10, -4);
    expect(frames.scopes.length).toBe(count * song.channels * SCOPE_POINTS);
    expect(frames.scopes.some((v) => Math.abs(v) > 10)).toBe(true);
    expect(frames.states.at(-1)!.row).toBeGreaterThan(10);
    expect(last.transfer).toEqual([frames.left.buffer, frames.right.buffer, frames.scopes.buffer]);
    expect(replies.filter((r) => r.message.type === 'progress').length).toBeGreaterThan(0);
  });

  it('encodes every frame and its audio into the wanted container', async () => {
    const last = await send('encode');
    expect(last.message).toMatchObject({ type: 'done', fileName: 'tune.mp4', codecs: 'AVC + AAC', bytes: new Uint8Array([1, 2, 3]) });
    const [output] = media.outputs;
    expect(output).toMatchObject({ format: 'mp4', tags: { title: 'Tune' }, finalized: true });
    // Video and audio frames line up, 1/10 s apart.
    expect(output!.video.slice(0, 3)).toEqual([0, 0.1, 0.2]);
    expect(output!.audio.map((a) => a.timestamp)).toEqual(output!.video);
    expect(output!.audio[0]!.frames).toBe(VIDEO_SAMPLE_RATE / 10);
    const done = last.message as Extract<VideoReply, { type: 'done' }>;
    expect(done.seconds).toBeCloseTo(output!.video.length / 10, 6);
    expect(fonts).toHaveLength(1);
  });

  it('falls back to the other container, and Opus for MP4 when there is no AAC', async () => {
    media.missing.add('avc');
    expect((await send('encode')).message).toMatchObject({ fileName: 'tune.webm', codecs: 'VP9 + OPUS' });
    media.missing.add('vp9');
    expect((await send('encode')).message).toMatchObject({ fileName: 'tune.webm', codecs: 'VP8 + OPUS' });
    media.missing.clear();
    for (const codec of ['vp9', 'vp8', 'av1', 'aac']) media.missing.add(codec);
    expect((await send('encode', { container: 'webm', title: '' })).message).toMatchObject({ fileName: 'tune.mp4', codecs: 'AVC + OPUS' });
    expect(media.outputs.at(-1)!.tags).toBeNull();
  });

  it('says so when nothing can be encoded here', async () => {
    media.missing.add('avc');
    media.missing.add('opus');
    expect((await send('encode')).message).toEqual({ type: 'unsupported' });
    vi.stubGlobal('VideoEncoder', undefined);
    media.missing.clear();
    expect((await send('encode')).message).toEqual({ type: 'unsupported' });
  });

  it('draws without the pixel font when it cannot load', async () => {
    expect((await send('encode', { fonts: [{ url: 'missing.woff2', range: '' }] })).message.type).toBe('done');
    expect(fonts).toEqual([]);
    scope.fonts = undefined;
    expect((await send('encode')).message.type).toBe('done');
  });

  it('reports errors as a message', async () => {
    const last = await send('frames', { song: { ...short(), orders: null } as unknown as Song });
    expect(last.message.type).toBe('error');
  });
});
