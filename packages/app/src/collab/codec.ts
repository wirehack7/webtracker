/**
 * Turns jam messages into bytes and back. Plain values go into JSON; typed
 * arrays (pattern data, keymaps, sample data) go after it as raw bytes, so a
 * song with long samples stays compact and quick to pack.
 *
 * Layout, little endian: u32 JSON length, the JSON, each array's bytes
 * starting on a multiple of 4, then a u32 offset and length per array and
 * the u32 array count.
 */

type Kind = 'u8' | 'u32' | 'f32';
interface Ref {
  $bin: number;
  kind: Kind;
}

const align = (n: number) => (n + 3) & ~3;

function kindOf(value: unknown): Kind | null {
  if (value instanceof Uint8Array) return 'u8';
  if (value instanceof Uint32Array) return 'u32';
  if (value instanceof Float32Array) return 'f32';
  return null;
}

export function encode(value: unknown): Uint8Array {
  const arrays: Uint8Array[] = [];
  const walk = (v: unknown): unknown => {
    const kind = kindOf(v);
    if (kind) {
      const typed = v as Uint8Array | Uint32Array | Float32Array;
      arrays.push(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
      return { $bin: arrays.length - 1, kind } satisfies Ref;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) if (item !== undefined) out[key] = walk(item);
      return out;
    }
    return v;
  };
  const json = new TextEncoder().encode(JSON.stringify(walk(value)));
  let size = align(4 + json.length);
  const offsets = arrays.map((a) => {
    const at = size;
    size = align(size + a.length);
    return at;
  });
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  arrays.forEach((a, i) => out.set(a, offsets[i]!));
  return withTable(out, offsets, arrays);
}

/** Appends the offset and length of every array, then their count. */
function withTable(body: Uint8Array, offsets: number[], arrays: Uint8Array[]): Uint8Array {
  const table = new Uint32Array(arrays.length * 2 + 1);
  arrays.forEach((a, i) => {
    table[i * 2] = offsets[i]!;
    table[i * 2 + 1] = a.length;
  });
  table[arrays.length * 2] = arrays.length;
  const out = new Uint8Array(body.length + table.byteLength);
  out.set(body);
  new Uint8Array(out.buffer, body.length).set(new Uint8Array(table.buffer));
  return out;
}

export function decode(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(bytes.length - 4, true);
  const tableAt = bytes.length - 4 - count * 8;
  if (count > 1e6 || tableAt < 4) throw new Error('Broken jam message');
  const jsonLength = view.getUint32(0, true);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)));
  const array = (ref: Ref): Uint8Array | Uint32Array | Float32Array => {
    const offset = view.getUint32(tableAt + ref.$bin * 8, true);
    const length = view.getUint32(tableAt + ref.$bin * 8 + 4, true);
    // A copy, so the result owns an aligned buffer of its own.
    const raw = bytes.slice(offset, offset + length);
    if (ref.kind === 'u32') return new Uint32Array(raw.buffer);
    if (ref.kind === 'f32') return new Float32Array(raw.buffer);
    return raw;
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if ('$bin' in v && 'kind' in v) return array(v as Ref);
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) out[key] = walk(item);
      return out;
    }
    return v;
  };
  return walk(parsed);
}
