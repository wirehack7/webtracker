import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Player } from '@webtracker/engine';
import { loadModule } from './index.ts';

/**
 * Optional robustness run over a directory of real modules:
 *   MODULE_DIR=~/mods npm test
 * Every file must load (or be rejected with an Error) and render 10 s without NaN.
 */
const dir = process.env.MODULE_DIR;

function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(mod|xm)$/i.test(f) ? [p] : [];
  });
}

describe.skipIf(!dir)('module corpus', () => {
  for (const file of dir ? walk(dir) : []) {
    it(file, () => {
      const buf = readFileSync(file);
      let song;
      try {
        song = loadModule(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), file);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        return;
      }
      const player = new Player(song, 44100);
      player.playing = true;
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      for (let i = 0; i < (44100 * 10) / 128; i++) {
        player.process(l, r);
        for (let k = 0; k < 128; k++) if (!Number.isFinite(l[k]) || !Number.isFinite(r[k])) throw new Error(`NaN at block ${i}`);
      }
    });
  }
});
