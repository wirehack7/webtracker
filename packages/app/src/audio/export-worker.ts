/**
 * Renders the song to WAV off the main thread, with the same engine the
 * worklet plays, so the export sounds exactly like playback.
 */
import { renderSong, type Resampler, type Song } from '@webtracker/engine';
import { createZip, encodeWav, type WavFormat, type ZipEntry } from '@webtracker/formats';

export interface ExportRequest {
  song: Song;
  format: WavFormat;
  sampleRate: number;
  /** One WAV per channel in a ZIP, plus the mix, instead of the mix alone. */
  stems: boolean;
  /** Channels muted in the tracker stay out of the mix. */
  muted: boolean[];
  resampler: Resampler;
  stereoSeparation: number;
  volumeRamps: boolean;
  amplify: number;
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

scope.onmessage = (event) => {
  const { song, format, sampleRate, stems, muted, name, resampler, stereoSeparation, volumeRamps, amplify } = event.data;
  const mixer = { resampler, stereoSeparation, volumeRamps, amplify };
  try {
    const passes = stems ? song.channels + 1 : 1;
    const progress = (pass: number) => (f: number) => scope.postMessage({ type: 'progress', fraction: (pass + f) / passes });

    const mix = renderSong(song, { sampleRate, muted, ...mixer, onProgress: progress(0) });
    const seconds = mix.left.length / sampleRate;
    const mixWav = encodeWav([mix.left, mix.right], sampleRate, format);
    if (!stems) {
      scope.postMessage({ type: 'done', bytes: mixWav, fileName: `${name}.wav`, seconds }, [mixWav.buffer]);
      return;
    }

    const entries: ZipEntry[] = [{ name: `${name}.wav`, data: mixWav }];
    for (let c = 0; c < song.channels; c++) {
      const solo = Array.from({ length: song.channels }, (_, k) => k !== c);
      const stem = renderSong(song, { sampleRate, muted: solo, ...mixer, onProgress: progress(c + 1) });
      // Channels that never sound would only add silent files.
      if (!stem.left.some((v) => v !== 0) && !stem.right.some((v) => v !== 0)) continue;
      entries.push({ name: `${name} - channel ${pad(c)}.wav`, data: encodeWav([stem.left, stem.right], sampleRate, format) });
    }
    const zip = createZip(entries);
    scope.postMessage({ type: 'done', bytes: zip, fileName: `${name} stems.zip`, seconds }, [zip.buffer]);
  } catch (error) {
    scope.postMessage({ type: 'error', message: (error as Error).message });
  }
};
