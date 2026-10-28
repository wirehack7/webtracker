/**
 * The fallback for browsers whose WebCodecs can't encode video and audio:
 * plays the rendered frames on a page canvas and records canvas and sound
 * with MediaRecorder. It runs in real time, so a three minute song takes
 * three minutes, and the tab has to stay in front.
 */
import { VideoPainter, type PainterOptions } from './draw.ts';
import { SCOPE_POINTS } from './frames.ts';
import type { RecordedFrames } from './video-worker.ts';

const MIME_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

/** Whether this browser can record a canvas with sound at all. */
export const canRecord = () =>
  typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && typeof AudioContext !== 'undefined';

export interface Recording {
  blob: Blob;
  extension: 'mp4' | 'webm';
}

export interface RecordOptions {
  frames: RecordedFrames;
  fps: number;
  painter: Omit<PainterOptions, 'makeCanvas'>;
  /** Made while the click that started the export still counts, so it may play. */
  audio: AudioContext;
  /** The canvas is shown here while it records. */
  preview: HTMLElement;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

export async function recordVideo(options: RecordOptions): Promise<Recording> {
  const { frames, fps, audio, painter: painterOptions, signal } = options;
  const { width, height } = painterOptions.layout;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'video-preview';
  options.preview.replaceChildren(canvas);
  const g = canvas.getContext('2d')!;
  await document.fonts.load('16px "Press Start 2P"').catch(() => undefined);
  const painter = new VideoPainter({
    ...painterOptions,
    makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
  });
  const channels = painterOptions.song.channels;
  const count = frames.states.length;
  const drawFrame = (index: number) => {
    const scopes = Array.from({ length: channels }, (_, c) => {
      const at = (index * channels + c) * SCOPE_POINTS;
      return Float32Array.from(frames.scopes.subarray(at, at + SCOPE_POINTS), (v) => v / 127);
    });
    painter.draw(g, frames.states[index]!, scopes, index / fps);
  };

  await audio.resume();
  const buffer = audio.createBuffer(2, Math.max(1, frames.left.length), frames.sampleRate);
  buffer.copyToChannel(frames.left as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(frames.right as Float32Array<ArrayBuffer>, 1);
  const source = audio.createBufferSource();
  source.buffer = buffer;
  const destination = audio.createMediaStreamDestination();
  source.connect(destination);

  const stream = new MediaStream([...canvas.captureStream(fps).getVideoTracks(), ...destination.stream.getAudioTracks()]);
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));

  drawFrame(0);
  recorder.start(1000);
  const start = audio.currentTime + 0.1;
  source.start(start);
  let shown = 0;
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (signal.aborted) return resolve();
      const index = Math.floor((audio.currentTime - start) * fps);
      if (index >= count) return resolve();
      if (index > shown) {
        shown = index;
        drawFrame(index);
        options.onProgress(index / count);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  source.stop();
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  canvas.remove();
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const type = recorder.mimeType || mimeType || 'video/webm';
  return { blob: new Blob(chunks, { type: type.split(';')[0] ?? type }), extension: type.includes('mp4') ? 'mp4' : 'webm' };
}
