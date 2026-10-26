/**
 * Share links: the whole song, compressed, in the URL fragment. The part
 * after # never reaches the server, so a link works without a backend and
 * the song stays between the people who have the link.
 */

import { cleanedCopy, type Song } from '@webtracker/engine';
import { t } from '../i18n/i18n.ts';
import type { AutosaveOrigin } from './autosave.ts';

/** `#song=…` in the address opens the song. */
export const SHARE_PARAM = 'song';
const VERSION = 1;

/**
 * How much a link may change the sound to get shorter.
 * - lossless: the song as it is.
 * - small: 8-bit samples, nothing after a loop's end.
 * - smallest: also half the sample rate for long samples (XM only).
 */
export type ShareQuality = 'lossless' | 'small' | 'smallest';

/** A copy of the song made smaller for a link at the given quality. */
export function shrinkSong(song: Song, quality: ShareQuality): Song {
  if (quality === 'lossless') return song;
  return cleanedCopy(song, {
    unusedPatterns: false,
    duplicatePatterns: false,
    unusedInstruments: false,
    compactInstruments: false,
    unusedSamples: false,
    sampleTails: true,
    halveRate: quality === 'smallest',
    eightBit: true,
  }).song;
}

export async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * The link text for a song saved as XM: a version byte, the length and JSON
 * of what XM loses for a MOD, then the XM bytes, all deflated.
 */
export async function encodeShare(xm: Uint8Array, origin?: AutosaveOrigin): Promise<string> {
  const meta = new TextEncoder().encode(origin?.format === 'mod' ? JSON.stringify(origin) : '');
  const payload = new Uint8Array(3 + meta.length + xm.length);
  payload[0] = VERSION;
  payload[1] = meta.length & 0xff;
  payload[2] = meta.length >> 8;
  payload.set(meta, 3);
  payload.set(xm, 3 + meta.length);
  return toBase64Url(await pipe(payload, new CompressionStream('deflate-raw')));
}

export async function decodeShare(text: string): Promise<{ xm: Uint8Array; origin?: AutosaveOrigin }> {
  let payload: Uint8Array;
  try {
    payload = await pipe(fromBase64Url(text), new DecompressionStream('deflate-raw'));
  } catch {
    throw new Error(t('the link is damaged or cut off'));
  }
  if (payload[0] !== VERSION) throw new Error(t('the link is from a newer version of the tracker'));
  const metaLength = payload[1]! | (payload[2]! << 8);
  const meta = new TextDecoder().decode(payload.subarray(3, 3 + metaLength));
  const xm = payload.slice(3 + metaLength);
  return meta ? { xm, origin: JSON.parse(meta) as AutosaveOrigin } : { xm };
}

/**
 * The address of the replayer page with a module file in its fragment
 * (`#module=…&name=…`, the bytes deflated), so it opens there at once.
 */
export async function replayerUrl(base: string, bytes: Uint8Array, fileName: string): Promise<string> {
  const url = new URL('./replayer/', base);
  url.hash = `module=${toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')))}&name=${encodeURIComponent(fileName)}`;
  return url.href;
}

/** The song in a `#song=…` fragment, or null when the address has none. */
export function shareFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.get(SHARE_PARAM);
}
