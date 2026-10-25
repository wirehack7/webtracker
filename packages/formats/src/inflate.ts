/**
 * Synchronous raw DEFLATE decoder (RFC 1951), for modules packed in ZIP and
 * gzip files. Module loading is synchronous, so the browser's
 * DecompressionStream cannot be used here.
 */

type Huffman = { counts: Uint16Array; symbols: Uint16Array };

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Uint16Array(16);
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1]! + counts[i - 1]!;
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offsets[lengths[i]!]!++] = i;
  return { counts, symbols };
}

const FIXED_LITERALS = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)), 288);
const FIXED_DISTANCES = huffman(new Array<number>(30).fill(5), 30);

/** Inflates raw DEFLATE data. `sizeHint` presizes the output when the unpacked size is known. */
export function inflateRaw(src: Uint8Array, sizeHint = 0): Uint8Array {
  let out = new Uint8Array(Math.max(1024, sizeHint));
  let outPos = 0;
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  const bits = (n: number): number => {
    while (bitCount < n) {
      if (pos >= src.length) throw new Error('Packed data ends early');
      bitBuf |= src[pos++]! << bitCount;
      bitCount += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len]!;
      if (code - first < count) return h.symbols[index + code - first]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('Invalid packed data');
  };
  const ensure = (n: number) => {
    if (outPos + n <= out.length) return;
    const grown = new Uint8Array(Math.max(out.length * 2, outPos + n));
    grown.set(out.subarray(0, outPos));
    out = grown;
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCount = 0;
      if (pos + 4 > src.length) throw new Error('Packed data ends early');
      const len = src[pos]! | (src[pos + 1]! << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error('Packed data ends early');
      ensure(len);
      out.set(src.subarray(pos, pos + len), outPos);
      outPos += len;
      pos += len;
      continue;
    }
    let literals = FIXED_LITERALS;
    let distances = FIXED_DISTANCES;
    if (type === 2) {
      const numLiterals = bits(5) + 257;
      const numDistances = bits(5) + 1;
      const numCodes = bits(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < numCodes; i++) codeLengths[CODE_LENGTH_ORDER[i]!] = bits(3);
      const codes = huffman(codeLengths, 19);
      const lengths = new Uint8Array(numLiterals + numDistances);
      for (let i = 0; i < lengths.length; ) {
        const sym = decode(codes);
        if (sym < 16) {
          lengths[i++] = sym;
          continue;
        }
        let repeat = 0;
        let value = 0;
        if (sym === 16) {
          if (i === 0) throw new Error('Invalid packed data');
          value = lengths[i - 1]!;
          repeat = 3 + bits(2);
        } else if (sym === 17) {
          repeat = 3 + bits(3);
        } else {
          repeat = 11 + bits(7);
        }
        if (i + repeat > lengths.length) throw new Error('Invalid packed data');
        lengths.fill(value, i, i + repeat);
        i += repeat;
      }
      literals = huffman(lengths.subarray(0, numLiterals), numLiterals);
      distances = huffman(lengths.subarray(numLiterals), numDistances);
    } else if (type !== 1) {
      throw new Error('Invalid packed data');
    }
    for (;;) {
      const sym = decode(literals);
      if (sym < 256) {
        ensure(1);
        out[outPos++] = sym;
        continue;
      }
      if (sym === 256) break;
      const l = sym - 257;
      if (l >= 29) throw new Error('Invalid packed data');
      const length = LENGTH_BASE[l]! + bits(LENGTH_EXTRA[l]!);
      const d = decode(distances);
      if (d >= 30) throw new Error('Invalid packed data');
      const distance = DIST_BASE[d]! + bits(DIST_EXTRA[d]!);
      if (distance > outPos) throw new Error('Invalid packed data');
      ensure(length);
      for (let i = 0; i < length; i++, outPos++) out[outPos] = out[outPos - distance]!;
    }
  }
  return out.slice(0, outPos);
}
