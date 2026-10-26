/**
 * Renders the song as a video off the main thread: the engine plays it frame
 * by frame, each frame is drawn on an OffscreenCanvas and both go through
 * WebCodecs into an MP4 or WebM file (muxed by Mediabunny), faster than real
 * time. Where WebCodecs can't encode, it hands back the frames instead, and
 * the page records them in real time (see recorder.ts).
 */
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  WebMOutputFormat,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import type { PlayerState, Resampler, Song } from '@webtracker/engine';
import { VideoPainter, VIDEO_FONT, videoLayout, type VideoTheme } from './draw.ts';
import { SCOPE_POINTS, VIDEO_SAMPLE_RATE, videoFrames } from './frames.ts';

export type VideoContainer = 'mp4' | 'webm';

export interface VideoRequest {
  /** 'encode' makes the file here; 'frames' only renders audio and frame data for the recorder. */
  mode: 'encode' | 'frames';
  song: Song;
  title: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  container: VideoContainer;
  theme: VideoTheme;
  beat: number;
  bar: number;
  /** The pixel font's files, as the page loaded them. */
  fonts: { url: string; range: string }[];
  muted: boolean[];
  resampler: Resampler;
  stereoSeparation: number;
  volumeRamps: boolean;
  amplify: number;
  karplusStrong: boolean;
}

/** Everything the recorder needs to draw and play the video in real time. */
export interface RecordedFrames {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  states: PlayerState[];
  /** SCOPE_POINTS per channel and frame, scaled to -127..127. */
  scopes: Int8Array;
}

export type VideoReply =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; bytes: Uint8Array; fileName: string; seconds: number; codecs: string }
  | { type: 'frames'; frames: RecordedFrames }
  /** WebCodecs can't make any of the formats here; the page falls back to recording. */
  | { type: 'unsupported' }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<VideoRequest>) => void) | null;
  postMessage(message: VideoReply, transfer?: Transferable[]): void;
  fonts?: FontFaceSet;
};

const VIDEO_CODECS: Record<VideoContainer, VideoCodec[]> = { mp4: ['avc'], webm: ['vp9', 'vp8', 'av1'] };
// Browsers without an AAC encoder (Firefox, Chromium builds) put Opus in the MP4.
const AUDIO_CODECS: Record<VideoContainer, AudioCodec[]> = { mp4: ['aac', 'opus'], webm: ['opus'] };

/** The first container, the wanted one before the other, that this browser can fill. */
async function pickCodecs(wanted: VideoContainer, width: number, height: number) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  for (const container of wanted === 'mp4' ? (['mp4', 'webm'] as const) : (['webm', 'mp4'] as const)) {
    const video = await getFirstEncodableVideoCodec(VIDEO_CODECS[container], { width, height, quality: QUALITY_MEDIUM });
    const audio = await getFirstEncodableAudioCodec(AUDIO_CODECS[container], {
      numberOfChannels: 2,
      sampleRate: VIDEO_SAMPLE_RATE,
      quality: QUALITY_HIGH,
    });
    if (video && audio) return { container, video, audio };
  }
  return null;
}

async function loadFonts(fonts: VideoRequest['fonts']): Promise<void> {
  if (!scope.fonts || typeof FontFace === 'undefined') return;
  await Promise.all(
    fonts.map(async ({ url, range }) => {
      const face = new FontFace(VIDEO_FONT, `url(${url})`, { unicodeRange: range });
      scope.fonts!.add(await face.load());
    }),
  ).catch(() => undefined); // A missing font only changes the look.
}

const frameOptions = (r: VideoRequest) => ({
  fps: r.fps,
  muted: r.muted,
  resampler: r.resampler,
  stereoSeparation: r.stereoSeparation,
  volumeRamps: r.volumeRamps,
  amplify: r.amplify,
  karplusStrong: r.karplusStrong,
});

async function encode(request: VideoRequest): Promise<void> {
  const { song, width, height, fps } = request;
  const codecs = await pickCodecs(request.container, width, height);
  if (!codecs) {
    scope.postMessage({ type: 'unsupported' });
    return;
  }
  await loadFonts(request.fonts);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  const painter = new VideoPainter({
    song,
    title: request.title || 'untitled',
    theme: request.theme,
    layout: videoLayout(width, height, song.channels),
    muted: request.muted,
    beat: request.beat,
    bar: request.bar,
    makeCanvas: (w, h) => new OffscreenCanvas(w, h),
  });

  const target = new BufferTarget();
  const output = new Output({
    format: codecs.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target,
  });
  const video = new CanvasSource(canvas, { codec: codecs.video, quality: QUALITY_MEDIUM, keyFrameInterval: 2 });
  const audio = new AudioSampleSource({ codec: codecs.audio, quality: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);
  if (request.title) output.setMetadataTags({ title: request.title });
  await output.start();

  let seconds = 0;
  for (const frame of videoFrames(song, frameOptions(request))) {
    painter.draw(g, frame.state, frame.scopes, frame.time);
    await video.add(frame.time, 1 / fps);
    const n = frame.left.length;
    const data = new Float32Array(n * 2);
    data.set(frame.left);
    data.set(frame.right, n);
    const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: VIDEO_SAMPLE_RATE, timestamp: frame.time });
    await audio.add(sample);
    sample.close();
    seconds = frame.time + n / VIDEO_SAMPLE_RATE;
    if (frame.index % 15 === 0) scope.postMessage({ type: 'progress', fraction: frame.progress });
  }
  await output.finalize();
  const bytes = new Uint8Array(target.buffer!);
  scope.postMessage(
    {
      type: 'done',
      bytes,
      fileName: `${request.name}.${codecs.container}`,
      seconds,
      codecs: `${codecs.video.toUpperCase()} + ${codecs.audio.toUpperCase()}`,
    },
    [bytes.buffer],
  );
}

/** Audio and frame data for recording in real time, where WebCodecs can't encode. */
function collect(request: VideoRequest): void {
  const channels = request.song.channels;
  const lefts: Float32Array[] = [];
  const rights: Float32Array[] = [];
  const states: PlayerState[] = [];
  const scopes: Int8Array[] = [];
  for (const frame of videoFrames(request.song, frameOptions(request))) {
    lefts.push(frame.left);
    rights.push(frame.right);
    states.push(frame.state);
    const packed = new Int8Array(channels * SCOPE_POINTS);
    frame.scopes.forEach((wave, c) => wave.forEach((v, i) => (packed[c * SCOPE_POINTS + i] = Math.round(v * 127))));
    scopes.push(packed);
    if (frame.index % 15 === 0) scope.postMessage({ type: 'progress', fraction: frame.progress });
  }
  const join = <T extends Float32Array | Int8Array>(parts: T[], out: T) => {
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const length = lefts.reduce((n, p) => n + p.length, 0);
  const frames: RecordedFrames = {
    sampleRate: VIDEO_SAMPLE_RATE,
    left: join(lefts, new Float32Array(length)),
    right: join(rights, new Float32Array(length)),
    states,
    scopes: join(scopes, new Int8Array(scopes.length * channels * SCOPE_POINTS)),
  };
  scope.postMessage({ type: 'frames', frames }, [frames.left.buffer, frames.right.buffer, frames.scopes.buffer]);
}

scope.onmessage = async (event) => {
  try {
    if (event.data.mode === 'frames') collect(event.data);
    else await encode(event.data);
  } catch (error) {
    scope.postMessage({ type: 'error', message: (error as Error).message });
  }
};
