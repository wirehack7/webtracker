/**
 * Share links: the whole song, compressed, in the URL fragment. The part
 * after # never reaches the server, so a link works without a backend and
 * the song stays between the people who have the link.
 */

import { LoopType, type Song } from '@webtracker/engine';
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

/** Long enough that halving the rate leaves the sound recognisable; short chip loops stay. */
const HALVE_FROM = 512;

/** A copy of the song made smaller for a link at the given quality. */
export function shrinkSong(song: Song, quality: ShareQuality): Song {
  if (quality === 'lossless') return song;
  const copy = structuredClone(song);
  for (const ins of copy.instruments) {
    for (const s of ins.samples) {
      if (s.loopType !== LoopType.None && s.loopLength > 0) s.data = s.data.slice(0, s.loopStart + s.loopLength);
      // MOD periods are clamped to the Amiga range, so an octave down would not play back right.
      if (quality === 'smallest' && song.format === 'xm' && s.data.length >= HALVE_FROM && s.relativeNote - 12 >= -96) {
        const half = new Float32Array(s.data.length >> 1);
        for (let i = 0; i < half.length; i++) half[i] = (s.data[2 * i]! + s.data[2 * i + 1]!) / 2;
        s.data = half;
        s.loopStart >>= 1;
        s.loopLength >>= 1;
        s.relativeNote -= 12;
      }
      s.data = s.data.map((v) => Math.max(-128, Math.min(127, Math.round(v * 128))) / 128);
    }
  }
  return copy;
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
