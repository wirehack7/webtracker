/**
 * MP3 encoding with LAME (via lamejs). The encoder is loaded on first use so
 * WAV and FLAC exports never fetch it.
 */

const FRAME = 1152;

/** Bitrates offered in the export dialog, in kbit/s. */
export const MP3_BITRATES = [128, 192, 256, 320] as const;

/** MP3 knows 44.1 and 48 kHz but nothing above, so higher rates render at 48 kHz. */
export const mp3Rate = (sampleRate: number) => Math.min(sampleRate, 48000);

export async function encodeMp3(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  kbps: number,
  title: string,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const encoder = new Mp3Encoder(2, sampleRate, kbps);
  const chunks: Uint8Array[] = [id3(title)];
  const step = FRAME * 64;
  const l = new Int16Array(step);
  const r = new Int16Array(step);
  const toInt = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let start = 0; start < left.length; start += step) {
    const n = Math.min(step, left.length - start);
    for (let i = 0; i < n; i++) {
      l[i] = toInt(left[start + i]!);
      r[i] = toInt(right[start + i]!);
    }
    chunks.push(encoder.encodeBuffer(l.subarray(0, n), r.subarray(0, n)).slice());
    onProgress?.((start + n) / left.length);
  }
  chunks.push(encoder.flush().slice());

  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** An ID3v2.4 tag with the title and the encoder, in UTF-8. */
export function id3(title: string): Uint8Array {
  const text = new TextEncoder();
  const frame = (id: string, value: string) => {
    const body = text.encode(value);
    const out = new Uint8Array(10 + 1 + body.length);
    out.set(text.encode(id), 0);
    out.set(syncsafe(body.length + 1), 4);
    out[10] = 3; // UTF-8
    out.set(body, 11);
    return out;
  };
  const frames = [...(title ? [frame('TIT2', title)] : []), frame('TSSE', 'chiptrackr')];
  const size = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(10 + size);
  out.set([0x49, 0x44, 0x33, 4, 0, 0], 0);
  out.set(syncsafe(size), 6);
  let o = 10;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
