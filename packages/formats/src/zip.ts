/** Builds an uncompressed ZIP archive, enough to hand over several WAV stems in one download. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const files = entries.map((e) => ({ name: encoder.encode(e.name), data: e.data, crc: crc32(e.data) }));
  const localSize = files.reduce((n, f) => n + 30 + f.name.length + f.data.length, 0);
  const centralSize = files.reduce((n, f) => n + 46 + f.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const v = new DataView(out.buffer);
  // 1980-01-01 00:00, the earliest DOS date; the stems have no meaningful time.
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;

  let o = 0;
  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(o);
    v.setUint32(o, 0x04034b50, true);
    v.setUint16(o + 4, 20, true);
    v.setUint16(o + 6, 0x0800, true); // UTF-8 names
    v.setUint16(o + 8, 0, true); // stored
    v.setUint16(o + 10, 0, true);
    v.setUint16(o + 12, DOS_DATE, true);
    v.setUint32(o + 14, f.crc, true);
    v.setUint32(o + 18, f.data.length, true);
    v.setUint32(o + 22, f.data.length, true);
    v.setUint16(o + 26, f.name.length, true);
    v.setUint16(o + 28, 0, true);
    out.set(f.name, o + 30);
    out.set(f.data, o + 30 + f.name.length);
    o += 30 + f.name.length + f.data.length;
  }

  const central = o;
  files.forEach((f, i) => {
    v.setUint32(o, 0x02014b50, true);
    v.setUint16(o + 4, 20, true);
    v.setUint16(o + 6, 20, true);
    v.setUint16(o + 8, 0x0800, true);
    v.setUint16(o + 10, 0, true);
    v.setUint16(o + 12, 0, true);
    v.setUint16(o + 14, DOS_DATE, true);
    v.setUint32(o + 16, f.crc, true);
    v.setUint32(o + 20, f.data.length, true);
    v.setUint32(o + 24, f.data.length, true);
    v.setUint16(o + 28, f.name.length, true);
    v.setUint32(o + 42, offsets[i]!, true);
    out.set(f.name, o + 46);
    o += 46 + f.name.length;
  });

  v.setUint32(o, 0x06054b50, true);
  v.setUint16(o + 8, files.length, true);
  v.setUint16(o + 10, files.length, true);
  v.setUint32(o + 12, o - central, true);
  v.setUint32(o + 16, central, true);
  return out;
}
