export type WavFormat = 'pcm16' | 'pcm24' | 'float32';

/** Interleaves the channels into a RIFF WAVE file. Values outside -1..1 are clipped for PCM. */
export function encodeWav(channels: Float32Array[], sampleRate: number, format: WavFormat = 'pcm16'): Uint8Array {
  const count = channels.length;
  const frames = Math.min(...channels.map((c) => c.length));
  const bytesPer = format === 'pcm16' ? 2 : format === 'pcm24' ? 3 : 4;
  const dataBytes = frames * count * bytesPer;
  const out = new Uint8Array(44 + dataBytes + (dataBytes & 1));
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  v.setUint32(4, out.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, format === 'float32' ? 3 : 1, true);
  v.setUint16(22, count, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * count * bytesPer, true);
  v.setUint16(32, count * bytesPer, true);
  v.setUint16(34, bytesPer * 8, true);
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);

  const clip = (x: number) => Math.max(-1, Math.min(1, x));
  let o = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < count; c++) {
      const x = channels[c]![f]!;
      if (format === 'float32') {
        v.setFloat32(o, x, true);
      } else if (format === 'pcm16') {
        v.setInt16(o, Math.round(clip(x) * 32767), true);
      } else {
        const s = Math.round(clip(x) * 8388607);
        out[o] = s & 0xff;
        out[o + 1] = (s >> 8) & 0xff;
        out[o + 2] = (s >> 16) & 0xff;
      }
      o += bytesPer;
    }
  }
  return out;
}
