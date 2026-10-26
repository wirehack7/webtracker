/**
 * Runs a video export from the page: WebCodecs in a worker where the browser
 * can encode, otherwise rendering in the worker and recording in real time.
 */
import latinFont from '@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2?url';
import latinExtFont from '@fontsource/press-start-2p/files/press-start-2p-latin-ext-400-normal.woff2?url';
import { THEME_PROPERTIES, videoLayout, type VideoTheme } from './draw.ts';
import { canRecord, recordVideo } from './recorder.ts';
import type { VideoReply, VideoRequest } from './video-worker.ts';

// The unicode ranges of @fontsource/press-start-2p/400.css.
const FONTS = [
  {
    url: latinFont,
    range:
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  },
  {
    url: latinExtFont,
    range:
      'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  },
];

/** The current theme's colours, including the ones changed in Setup. */
export function readVideoTheme(): VideoTheme {
  const css = getComputedStyle(document.documentElement);
  const entries = Object.entries(THEME_PROPERTIES).map(([key, property]) => [key, css.getPropertyValue(property).trim() || '#000']);
  return Object.fromEntries(entries) as VideoTheme;
}

/** Whether WebCodecs may be able to encode here; the worker checks the codecs. */
const canEncode = () => typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

/** Whether this browser can make a video in any way. */
export const canExportVideo = () => canEncode() || canRecord();

export type VideoSettings = Omit<VideoRequest, 'mode' | 'fonts' | 'theme'>;

export interface VideoResult {
  data: Uint8Array | Blob;
  fileName: string;
  seconds: number;
  /** The codecs, when WebCodecs made the file. */
  codecs: string;
  /** Recorded in real time with MediaRecorder. */
  recorded: boolean;
}

export interface VideoHooks {
  onProgress: (fraction: number) => void;
  /** Called once if the export switches to recording in real time. */
  onRecording: () => void;
  /** Where the recording shows while it runs. */
  preview: HTMLElement;
  signal: AbortSignal;
}

/** Must be called straight from a click: a recording needs an AudioContext made in it. */
export function exportVideo(settings: VideoSettings, hooks: VideoHooks): Promise<VideoResult> {
  const fonts = FONTS.map((f) => ({ ...f, url: new URL(f.url, location.href).href }));
  const base: Omit<VideoRequest, 'mode'> = { ...settings, theme: readVideoTheme(), fonts };
  // Browsers that will need the recorder get their audio context while the click still counts.
  let audio: AudioContext | null = !canEncode() && canRecord() ? new AudioContext({ sampleRate: 48000 }) : null;

  const run = (mode: VideoRequest['mode']) =>
    new Promise<VideoReply>((resolve, reject) => {
      const worker = new Worker(new URL('./video-worker.ts', import.meta.url), { type: 'module' });
      const stop = () => {
        worker.terminate();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      hooks.signal.addEventListener('abort', stop, { once: true });
      worker.onmessage = (event: MessageEvent<VideoReply>) => {
        const reply = event.data;
        if (reply.type === 'progress') {
          // Recording takes the second half of the bar.
          hooks.onProgress(mode === 'frames' ? reply.fraction / 2 : reply.fraction);
          return;
        }
        worker.terminate();
        hooks.signal.removeEventListener('abort', stop);
        resolve(reply);
      };
      worker.onerror = (event) => {
        worker.terminate();
        hooks.signal.removeEventListener('abort', stop);
        reject(new Error(event.message));
      };
      worker.postMessage({ ...base, mode } satisfies VideoRequest);
    });

  const record = async (): Promise<VideoResult> => {
    if (!canRecord()) throw new Error('This browser can neither encode nor record video.');
    hooks.onRecording();
    audio ??= new AudioContext({ sampleRate: 48000 });
    try {
      const reply = await run('frames');
      if (reply.type === 'error') throw new Error(reply.message);
      if (reply.type !== 'frames') throw new Error('No frames');
      const { frames } = reply;
      const recording = await recordVideo({
        frames,
        fps: settings.fps,
        audio,
        preview: hooks.preview,
        signal: hooks.signal,
        onProgress: (f) => hooks.onProgress(0.5 + f / 2),
        painter: {
          song: settings.song,
          title: settings.title || 'untitled',
          theme: base.theme,
          layout: videoLayout(settings.width, settings.height, settings.song.channels),
          muted: settings.muted,
          beat: settings.beat,
          bar: settings.bar,
        },
      });
      return {
        data: recording.blob,
        fileName: `${settings.name}.${recording.extension}`,
        seconds: frames.left.length / frames.sampleRate,
        codecs: '',
        recorded: true,
      };
    } finally {
      void audio.close();
    }
  };

  if (!canEncode()) return record();
  return run('encode').then((reply) => {
    if (reply.type === 'unsupported') return record();
    if (reply.type === 'error') throw new Error(reply.message);
    if (reply.type !== 'done') throw new Error('No video');
    return { data: reply.bytes, fileName: reply.fileName, seconds: reply.seconds, codecs: reply.codecs, recorded: false };
  });
}
