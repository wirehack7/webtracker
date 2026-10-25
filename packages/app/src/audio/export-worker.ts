/**
 * Renders the song to WAV, FLAC or MP3 off the main thread, with the same engine the
 * worklet plays, so the export sounds exactly like playback.
 */
import { renderSong, type Resampler, type Song } from '@webtracker/engine';
import { createZip, encodeFlac, encodeWav, type ZipEntry } from '@webtracker/formats';
import type { AudioFormat } from './audio-format.ts';
import { encodeMp3, mp3Rate } from './mp3.ts';

export interface ExportRequest {
  song: Song;
  format: AudioFormat;
  sampleRate: number;
  /** One file per channel in a ZIP, plus the mix, instead of the mix alone. */
  stems: boolean;
  /** Channels muted in the tracker stay out of the mix. */
  muted: boolean[];
  resampler: Resampler;
  stereoSeparation: number;
  volumeRamps: boolean;
  amplify: number;
  karplusStrong: boolean;
  name: string;
}

export type ExportReply =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; bytes: Uint8Array; fileName: string; seconds: number }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ExportRequest>) => void) | null;
  postMessage(message: ExportReply, transfer?: Transferable[]): void;
};

const pad = (n: number) => String(n + 1).padStart(2, '0');

scope.onmessage = async (event) => {
  const { song, format, stems, muted, name, resampler, stereoSeparation, volumeRamps, amplify, karplusStrong } = event.data;
  const sampleRate = format.kind === 'mp3' ? mp3Rate(event.data.sampleRate) : event.data.sampleRate;
  const mixer = { resampler, stereoSeparation, volumeRamps, amplify, karplusStrong };
  const extension = format.kind;
  try {
    // Rendering takes most of the time for WAV and FLAC; MP3 encoding gets its own share.
    const passes = stems ? song.channels + 1 : 1;
    const renderShare = format.kind === 'mp3' ? 0.5 : 1;
    const report = (pass: number, f: number) => scope.postMessage({ type: 'progress', fraction: (pass + f) / passes });
    const encode = async (left: Float32Array, right: Float32Array, pass: number, title: string) => {
      if (format.kind === 'wav') return encodeWav([left, right], sampleRate, format.format);
      if (format.kind === 'flac') return encodeFlac([left, right], sampleRate, format.depth, title);
      return encodeMp3(left, right, sampleRate, format.kbps, title, (f) => report(pass, renderShare + f * (1 - renderShare)));
    };
    const render = (pass: number, mutedChannels: boolean[]) =>
      renderSong(song, { sampleRate, muted: mutedChannels, ...mixer, onProgress: (f) => report(pass, f * renderShare) });

    const mix = render(0, muted);
    const seconds = mix.left.length / sampleRate;
    const mixFile = await encode(mix.left, mix.right, 0, song.title.trim());
    if (!stems) {
      scope.postMessage({ type: 'done', bytes: mixFile, fileName: `${name}.${extension}`, seconds }, [mixFile.buffer]);
      return;
    }

    const entries: ZipEntry[] = [{ name: `${name}.${extension}`, data: mixFile }];
    for (let c = 0; c < song.channels; c++) {
      const solo = Array.from({ length: song.channels }, (_, k) => k !== c);
      const stem = render(c + 1, solo);
      // Channels that never sound would only add silent files.
      if (!stem.left.some((v) => v !== 0) && !stem.right.some((v) => v !== 0)) continue;
      const title = `${song.title.trim() || name} - channel ${pad(c)}`;
      entries.push({ name: `${name} - channel ${pad(c)}.${extension}`, data: await encode(stem.left, stem.right, c + 1, title) });
    }
    const zip = createZip(entries);
    scope.postMessage({ type: 'done', bytes: zip, fileName: `${name} stems.zip`, seconds }, [zip.buffer]);
  } catch (error) {
    scope.postMessage({ type: 'error', message: (error as Error).message });
  }
};
