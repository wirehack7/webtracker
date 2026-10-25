import type { FlacDepth, WavFormat } from '@webtracker/formats';

export type AudioFormat = { kind: 'wav'; format: WavFormat } | { kind: 'flac'; depth: FlacDepth } | { kind: 'mp3'; kbps: number };

/** Parses the export dialog's format choice, such as "wav:pcm16", "flac:24" or "mp3:320". */
export function parseAudioFormat(value: string): AudioFormat {
  const [kind, option = ''] = value.split(':');
  if (kind === 'flac') return { kind, depth: option === '24' ? 24 : 16 };
  if (kind === 'mp3') return { kind, kbps: Number(option) || 320 };
  return { kind: 'wav', format: option === 'pcm24' || option === 'float32' ? option : 'pcm16' };
}
