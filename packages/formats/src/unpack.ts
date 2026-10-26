/**
 * Unpacks modules that come inside a container: ZIP and gzip archives (also
 * as MDZ, XMZ, S3Z, ITZ and their gzip forms), MMCMP (ziRCONia),
 * PowerPacker (PP20) and Unreal music packages (UMX). Containers may nest,
 * so unpacking repeats until the data is no longer packed.
 */
import { inflateRaw } from './inflate.ts';

export interface Unpacked {
  bytes: Uint8Array;
  /** The name of the unpacked module, which the loader may need to recognise its format. */
  fileName: string;
  /** The container formats that were removed, outermost first. */
  containers: string[];
}

const MODULE_NAME = /\.(mod|xm|s3m|it|mtm|669|okt|stk)$|^mod\./i;
/** Single-module archive extensions and the module extension they stand for. */
const PACKED_EXTENSIONS: Record<string, string> = { mdz: 'mod', mdgz: 'mod', xmz: 'xm', xmgz: 'xm', s3z: 's3m', s3gz: 's3m', itz: 'it', itgz: 'it' };

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The module name inside a packed file, from the packed file's own name. */
function innerName(fileName: string): string {
  const match = /^(.*)\.([a-z0-9]+)$/i.exec(fileName);
  if (!match) return fileName;
  const ext = match[2]!.toLowerCase();
  if (PACKED_EXTENSIONS[ext]) return `${match[1]}.${PACKED_EXTENSIONS[ext]}`;
  if (ext === 'gz' || ext === 'zip') return match[1]!;
  return fileName;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8;
}

export function isMmcmp(bytes: Uint8Array): boolean {
  return bytes.length >= 24 && ascii(bytes, 0, 8) === 'ziRCONia' && (bytes[8]! | (bytes[9]! << 8)) === 14;
}

export function isPp20(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes.length % 2 !== 0 || ascii(bytes, 0, 4) !== 'PP20') return false;
  for (let i = 4; i < 8; i++) if (bytes[i]! < 9 || bytes[i]! > 15) return false;
  return true;
}

interface ZipDirEntry {
  name: string;
  method: number;
  packed: number;
  size: number;
  offset: number;
}

function zipDirectory(bytes: Uint8Array, fileName: string): ZipDirEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 22 - 0xffff); o--) {
    if (v.getUint32(o, true) === 0x06054b50) {
      end = o;
      break;
    }
  }
  if (end < 0) throw new Error(`${fileName || 'ZIP file'}: no ZIP directory found`);
  const count = v.getUint16(end + 10, true);
  let o = v.getUint32(end + 16, true);
  const entries: ZipDirEntry[] = [];
  for (let i = 0; i < count && o + 46 <= bytes.length; i++) {
    if (v.getUint32(o, true) !== 0x02014b50) break;
    const nameLength = v.getUint16(o + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(o + 46, o + 46 + nameLength));
    if (!name.endsWith('/')) {
      entries.push({ name, method: v.getUint16(o + 10, true), packed: v.getUint32(o + 20, true), size: v.getUint32(o + 24, true), offset: v.getUint32(o + 42, true) });
    }
    o += 46 + nameLength + v.getUint16(o + 30, true) + v.getUint16(o + 32, true);
  }
  return entries;
}

function zipData(bytes: Uint8Array, entry: ZipDirEntry): Uint8Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.offset;
  if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw new Error(`${entry.name}: damaged ZIP entry`);
  const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
  const packed = bytes.subarray(start, Math.min(bytes.length, start + entry.packed));
  if (entry.method === 0) return packed.slice();
  if (entry.method === 8) return inflateRaw(packed, entry.size);
  throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}`);
}

const baseName = (e: ZipDirEntry) => e.name.slice(e.name.lastIndexOf('/') + 1);

/** Picks the module from a ZIP archive: the first file with a module name, else the largest file. */
export function unzipModule(bytes: Uint8Array, fileName = ''): { bytes: Uint8Array; fileName: string } {
  const entries = zipDirectory(bytes, fileName);
  const entry = entries.find((e) => MODULE_NAME.test(baseName(e)) || PACKED_EXTENSIONS[baseName(e).split('.').pop()!.toLowerCase()]) ?? entries.reduce<ZipDirEntry | undefined>((a, e) => (!a || e.size > a.size ? e : a), undefined);
  if (!entry) throw new Error(`${fileName || 'ZIP file'}: the archive is empty`);
  return { bytes: zipData(bytes, entry), fileName: baseName(entry) };
}

/** Every file in a ZIP archive, with its full path inside the archive. */
export function unzipAll(bytes: Uint8Array, fileName = ''): { name: string; data: Uint8Array }[] {
  return zipDirectory(bytes, fileName).map((entry) => ({ name: entry.name, data: zipData(bytes, entry) }));
}

export function gunzip(bytes: Uint8Array, fileName = ''): { bytes: Uint8Array; fileName: string } {
  const flags = bytes[3]!;
  let o = 10;
  if (flags & 4) o += 2 + (bytes[o]! | (bytes[o + 1]! << 8));
  let name = innerName(fileName);
  if (flags & 8) {
    const zero = bytes.indexOf(0, o);
    const stored = new TextDecoder('latin1').decode(bytes.subarray(o, zero < 0 ? bytes.length : zero));
    if (stored) name = stored.slice(Math.max(stored.lastIndexOf('/'), stored.lastIndexOf('\\')) + 1);
    o = zero < 0 ? bytes.length : zero + 1;
  }
  if (flags & 16) {
    const zero = bytes.indexOf(0, o);
    o = zero < 0 ? bytes.length : zero + 1;
  }
  if (flags & 2) o += 2;
  const n = bytes.length;
  const size = (bytes[n - 4]! | (bytes[n - 3]! << 8) | (bytes[n - 2]! << 16) | (bytes[n - 1]! << 24)) >>> 0;
  return { bytes: inflateRaw(bytes.subarray(o, n - 8), Math.min(size, 64 << 20)), fileName: name };
}

const MMCMP8_COMMANDS = [0x01, 0x03, 0x07, 0x0f, 0x1e, 0x3c, 0x78, 0xf8];
const MMCMP8_FETCH = [3, 3, 3, 3, 2, 1, 0, 0];
const MMCMP16_COMMANDS = [0x01, 0x03, 0x07, 0x0f, 0x1e, 0x3c, 0x78, 0xf0, 0x1f0, 0x3f0, 0x7f0, 0xff0, 0x1ff0, 0x3ff0, 0x7ff0, 0xfff0];
const MMCMP16_FETCH = [4, 4, 4, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** Unpacks an MMCMP (ziRCONia) file, the packer used by many tracker module archives. */
export function unpackMmcmp(bytes: Uint8Array): Uint8Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = () => new Error('Damaged MMCMP data');
  const numBlocks = v.getUint16(12, true);
  const size = v.getUint32(14, true);
  const table = v.getUint32(18, true);
  if (!numBlocks || !size || size >= 0x80000000 || table < 24 || table + 4 * numBlocks > bytes.length) throw fail();
  const out = new Uint8Array(size);

  for (let b = 0; b < numBlocks; b++) {
    const at = v.getUint32(table + 4 * b, true);
    if (at + 20 > bytes.length) throw fail();
    const packedSize = v.getUint32(at + 4, true);
    const subBlocks = v.getUint16(at + 12, true);
    const flags = v.getUint16(at + 14, true);
    const tableEntries = v.getUint16(at + 16, true);
    let numBits = v.getUint16(at + 18, true);
    const subs: { position: number; size: number }[] = [];
    for (let s = 0; s < subBlocks; s++) {
      const so = at + 20 + s * 8;
      if (so + 8 > bytes.length) throw fail();
      const position = v.getUint32(so, true);
      const length = v.getUint32(so + 4, true);
      if (length === 0 || position >= size || length > size - position) throw fail();
      subs.push({ position, size: length });
    }
    const data = at + 20 + subBlocks * 8;
    if (data >= bytes.length || subs.length === 0) throw fail();

    if (!(flags & 1)) {
      // Stored sub-blocks follow each other after the block header.
      let from = data;
      for (const sub of subs) {
        if (from + sub.size > bytes.length) throw fail();
        out.set(bytes.subarray(from, from + sub.size), sub.position);
        from += sub.size;
      }
      continue;
    }

    // Bits are read from the least significant end of each byte.
    let pos = data + tableEntries;
    const endPos = Math.min(bytes.length, data + packedSize);
    let bitBuf = 0;
    let bitCount = 0;
    const bits = (n: number): number => {
      while (bitCount < n) {
        if (pos >= endPos) throw RangeError('end');
        bitBuf |= bytes[pos++]! << bitCount;
        bitCount += 8;
      }
      const value = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n;
      bitCount -= n;
      return value;
    };

    let sub = 0;
    let dest = subs[0]!.position;
    let left = flags & 4 ? subs[0]!.size & ~1 : subs[0]!.size;
    let old = 0;
    const nextSub = (): boolean => {
      sub++;
      if (sub >= subs.length) return false;
      dest = subs[sub]!.position;
      left = flags & 4 ? subs[sub]!.size & ~1 : subs[sub]!.size;
      if (!left) throw fail();
      return true;
    };
    try {
      if (flags & 4) {
        // 16-bit samples
        if (numBits > 15 || !left) throw fail();
        for (;;) {
          let value = 0x10000;
          let d = bits(numBits + 1);
          const command = MMCMP16_COMMANDS[numBits]!;
          if (d >= command) {
            const fetch = MMCMP16_FETCH[numBits]!;
            const newBits = bits(fetch) + ((d - command) << fetch);
            if (newBits !== numBits) numBits = newBits & 0x0f;
            else if ((d = bits(4)) === 0x0f) {
              if (bits(1)) break;
              value = 0xffff;
            } else value = 0xfff0 + d;
          } else value = d;
          if (value < 0x10000) {
            value = value & 1 ? -((value + 1) >> 1) & 0xffff : value >> 1;
            if (flags & 2) {
              value = (value + old) & 0xffff;
              old = value;
            } else if (!(flags & 0x200)) value ^= 0x8000;
            if (flags & 0x400) {
              out[dest] = value >> 8;
              out[dest + 1] = value & 0xff;
            } else {
              out[dest] = value & 0xff;
              out[dest + 1] = value >> 8;
            }
            dest += 2;
            left -= 2;
          }
          if (left <= 0 && !nextSub()) break;
        }
      } else {
        // 8-bit data through a translation table
        if (numBits > 7 || tableEntries > 256 || data + tableEntries > bytes.length) throw fail();
        const translate = bytes.subarray(data, data + tableEntries);
        for (;;) {
          let value = 0x100;
          let d = bits(numBits + 1);
          const command = MMCMP8_COMMANDS[numBits]!;
          if (d >= command) {
            const fetch = MMCMP8_FETCH[numBits]!;
            const newBits = bits(fetch) + ((d - command) << fetch);
            if (newBits !== numBits) numBits = newBits & 0x07;
            else if ((d = bits(3)) === 7) {
              if (bits(1)) break;
              value = 0xff;
            } else value = 0xf8 + d;
          } else value = d;
          if (value < 0x100) {
            let n = translate[value] ?? 0;
            if (flags & 2) {
              n = (n + old) & 0xff;
              old = n;
            }
            out[dest++] = n;
            left--;
          }
          if (left <= 0 && !nextSub()) break;
        }
      }
    } catch (e) {
      // Running out of packed bits ends the block, as in the original unpacker.
      if (!(e instanceof RangeError)) throw e;
    }
  }
  return out;
}

export function isUmx(bytes: Uint8Array): boolean {
  return bytes.length >= 64 && bytes[0] === 0xc1 && bytes[1] === 0x83 && bytes[2] === 0x2a && bytes[3] === 0x9e;
}

/**
 * Finds the module inside an Unreal music package (UMX). The package wraps
 * one S3M, XM, IT or MOD file; its own signature tells where it starts.
 */
export function unpackUmx(bytes: Uint8Array): { bytes: Uint8Array; extension: string } {
  const text = new TextDecoder('latin1').decode(bytes);
  const found = [
    { at: text.indexOf('Extended Module: '), extension: 'xm' },
    { at: text.indexOf('IMPM'), extension: 'it' },
    { at: text.indexOf('SCRM') - 44, extension: 's3m' },
    { at: text.search(/M\.K\.|M!K!|[4-8]CHN/) - 1080, extension: 'mod' },
  ].filter((f) => f.at > 0);
  const first = found.sort((a, b) => a.at - b.at)[0];
  if (!first) throw new Error('No module found in the UMX package');
  return { bytes: bytes.slice(first.at), extension: first.extension };
}

/** Unpacks a PowerPacker (PP20) data file, common for Amiga modules. */
export function unpackPp20(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  const outSize = (bytes[n - 4]! << 16) | (bytes[n - 3]! << 8) | bytes[n - 2]!;
  if (!outSize) throw new Error('Damaged PowerPacker data');
  const out = new Uint8Array(outSize);
  // The source runs from the efficiency table to the end of the file and is read backwards.
  const start = 4;
  const modes = [bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!];
  let src = n - 4;
  let bitCount = 0;
  let bitBuf = 0;
  const bits = (count: number): number => {
    let result = 0;
    for (let i = 0; i < count; i++) {
      if (!bitCount) {
        bitCount = 8;
        if (src !== start) src--;
        bitBuf = bytes[src]!;
      }
      result = (result << 1) | (bitBuf & 1);
      bitBuf >>= 1;
      bitCount--;
    }
    return result;
  };
  bits(bytes[n - 1]!);
  let left = outSize;
  while (left > 0) {
    if (!bits(1)) {
      let count = 1;
      let add: number;
      do {
        add = bits(2);
        count += add;
      } while (add === 3);
      count = Math.min(count, left);
      for (let i = 0; i < count; i++) out[--left] = bits(8);
      if (!left) break;
    }
    const mode = bits(2);
    let count = mode + 2;
    let offset: number;
    if (mode === 3) {
      offset = bits(bits(1) ? modes[3]! : 7);
      let add: number;
      do {
        add = bits(3);
        count += add;
      } while (add === 7);
    } else {
      offset = bits(modes[mode]!);
    }
    count = Math.min(count, left);
    for (let i = 0; i < count; i++) {
      out[left - 1] = left + offset < outSize ? out[left + offset]! : 0;
      left--;
    }
  }
  return out;
}

/** Removes every container around a module. Data that is not packed comes back unchanged. */
export function unpackModule(bytes: Uint8Array, fileName = ''): Unpacked {
  const containers: string[] = [];
  for (let depth = 0; depth < 4; depth++) {
    let next: { bytes: Uint8Array; fileName: string };
    if (isZip(bytes)) {
      containers.push('ZIP');
      next = unzipModule(bytes, fileName);
    } else if (isGzip(bytes)) {
      containers.push('gzip');
      next = gunzip(bytes, fileName);
    } else if (isMmcmp(bytes)) {
      containers.push('MMCMP');
      next = { bytes: unpackMmcmp(bytes), fileName };
    } else if (isUmx(bytes)) {
      containers.push('UMX');
      const inner = unpackUmx(bytes);
      next = { bytes: inner.bytes, fileName: `${fileName.replace(/\.[^.]*$/, '') || 'music'}.${inner.extension}` };
    } else if (isPp20(bytes)) {
      containers.push('PowerPacker');
      next = { bytes: unpackPp20(bytes), fileName };
    } else {
      break;
    }
    bytes = next.bytes;
    fileName = next.fileName;
  }
  return { bytes, fileName, containers };
}
