import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadModule } from './index.ts';
import { inflateRaw } from './inflate.ts';
import { unpackModule } from './unpack.ts';
import { createZip } from './zip.ts';
import { buildMod, packMmcmp, packPp20, squareWave } from './test-builders.ts';

const mod = new Uint8Array(
  buildMod({
    title: 'packed',
    samples: [{ data: squareWave(256), volume: 48 }],
    patterns: [[[{ note: 24, ins: 1, eff: 0xc, param: 0x20 }]]],
    orders: [0],
  }),
);

/** Mixed test data: runs, repeats, noise and the byte values that need escapes. */
function sampleData(length: number): Uint8Array {
  let seed = 1;
  return Uint8Array.from({ length }, (_, i) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    if (i % 300 < 100) return i % 7;
    if (i % 300 < 200) return seed >>> 24;
    return 0xf0 + (i % 16);
  });
}

/** A ZIP with one deflated entry, as written by common archivers. */
function deflatedZip(name: string, data: Uint8Array): Uint8Array {
  const stored = createZip([{ name, data }]);
  const packed = deflateRawSync(data);
  const nameLength = new TextEncoder().encode(name).length;
  const out = new Uint8Array(stored.length - data.length + packed.length);
  out.set(stored.subarray(0, 30 + nameLength));
  out.set(packed, 30 + nameLength);
  out.set(stored.subarray(30 + nameLength + data.length), 30 + nameLength + packed.length);
  const v = new DataView(out.buffer);
  const central = 30 + nameLength + packed.length;
  for (const [o, method] of [
    [8, 8],
    [central + 10, 8],
  ] as const)
    v.setUint16(o, method, true);
  v.setUint32(18, packed.length, true);
  v.setUint32(central + 20, packed.length, true);
  v.setUint32(out.length - 6, central, true);
  return out;
}

describe('inflate', () => {
  it('matches zlib for stored, fixed and dynamic blocks', () => {
    const data = sampleData(70000);
    for (const level of [0, 1, 9]) expect(inflateRaw(deflateRawSync(data, { level }))).toEqual(data);
    expect(inflateRaw(deflateRawSync(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it('rejects truncated data', () => {
    const packed = deflateRawSync(sampleData(5000));
    expect(() => inflateRaw(packed.subarray(0, packed.length >> 1))).toThrow();
  });
});

describe('module containers', () => {
  it('loads gzip-packed modules and keeps the stored name', () => {
    const unpacked = unpackModule(gzipSync(mod), 'song.mdgz');
    expect(unpacked.containers).toEqual(['gzip']);
    expect(unpacked.fileName).toBe('song.mod');
    expect(unpacked.bytes).toEqual(mod);
    expect(loadModule(gzipSync(mod).buffer as ArrayBuffer, 'song.mod.gz').title).toBe('packed');
  });

  it('picks the module from a ZIP archive', () => {
    const zip = createZip([
      { name: 'readme.txt', data: new Uint8Array(5000) },
      { name: 'music/tune.mod', data: mod },
    ]);
    const unpacked = unpackModule(zip, 'tune.mdz');
    expect(unpacked.fileName).toBe('tune.mod');
    expect(unpacked.bytes).toEqual(mod);
    const deflated = deflatedZip('tune.mod', mod);
    expect(unpackModule(deflated).bytes).toEqual(mod);
    expect(loadModule(deflated.slice().buffer, 'tune.zip').instruments[0]!.samples[0]!.volume).toBe(48);
  });

  it('unpacks MMCMP in 8 and 16 bits', () => {
    const data = sampleData(4000);
    expect(unpackModule(packMmcmp(data)).bytes).toEqual(data);
    expect(unpackModule(packMmcmp(data, true)).bytes).toEqual(data);
    expect(loadModule(packMmcmp(mod).slice().buffer).formatName).toMatch(/\(MMCMP\)$/);
  });

  it('unpacks PowerPacker data', () => {
    const data = sampleData(3000);
    const packed = packPp20(data);
    expect(packed.length).toBeLessThan(data.length);
    expect(unpackModule(packed).containers).toEqual(['PowerPacker']);
    expect(unpackModule(packed).bytes).toEqual(data);
    expect(loadModule(packPp20(mod).slice().buffer, 'tune.mod').title).toBe('packed');
  });

  it('unpacks nested containers', () => {
    const unpacked = unpackModule(createZip([{ name: 'tune.mod', data: packMmcmp(mod) }]));
    expect(unpacked.containers).toEqual(['ZIP', 'MMCMP']);
    expect(unpacked.bytes).toEqual(mod);
  });

  it('leaves plain modules alone', () => {
    const unpacked = unpackModule(mod, 'tune.mod');
    expect(unpacked.containers).toEqual([]);
    expect(unpacked.bytes).toBe(mod);
  });
});

describe('UMX packages', () => {
  it('finds the module after the package header', () => {
    const header = new Uint8Array(200);
    header.set([0xc1, 0x83, 0x2a, 0x9e]);
    const umx = new Uint8Array(header.length + mod.length + 50);
    umx.set(header);
    umx.set(mod, header.length);
    const unpacked = unpackModule(umx, 'Mech8.umx');
    expect(unpacked.containers).toEqual(['UMX']);
    expect(unpacked.fileName).toBe('Mech8.mod');
    expect(unpacked.bytes.subarray(0, mod.length)).toEqual(mod);
    expect(loadModule(umx.slice().buffer, 'Mech8.umx').formatName).toMatch(/\(UMX\)$/);
  });
});
