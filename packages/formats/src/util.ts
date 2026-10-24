/** Reads a fixed-length, NUL-padded ASCII string. */
export function readString(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = bytes[offset + i] ?? 0;
    if (c === 0) break;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
  }
  return s.trimEnd();
}
