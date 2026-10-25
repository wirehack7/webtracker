/**
 * Compares the replayer with libopenmpt on a folder of test modules, such as
 * the OpenMPT test cases in libxmp's test-dev/openmpt/{xm,mod}.
 *
 *   pnpm --filter @webtracker/formats reference-check <dir> [report.md] [--min-ref N] [--min-sides N]
 *
 * Needs an ffmpeg built with libopenmpt on the PATH. Each module is rendered
 * by our Player and by ffmpeg at 44.1 kHz, then scored with the mean cosine
 * similarity of per-frame log spectra (1 = same sound, 0 = unrelated).
 *
 * Two scores per module:
 * - "vs libopenmpt": our stereo mix against libopenmpt's. XM files get their
 *   tracker string set to "FastTracker v2.00" first, so libopenmpt plays them
 *   with FT2 rules rather than the quirks of old OpenMPT versions.
 * - "left vs right": most OpenMPT tests play the tested feature on one side
 *   and a plain version of the same sound on the other, so a correct player
 *   gives two matching sides (or silence for the "should stay quiet" tests).
 *
 * As a control, each module's render is also scored against libopenmpt's
 * render of the previous module in the list; that mean shows what unrelated
 * sounds score with this metric.
 *
 * --min-ref and --min-sides make the run fail when fewer modules pass, so CI
 * notices a regression.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Player } from '@webtracker/engine';
import { loadModule } from '../src/index.ts';

const SR = 44100;
const MAX_SECONDS = 30;
const PASS = 0.9;
const FRAME = 2048;
const HOP = 1024;

const args = process.argv.slice(2);
function option(name: string) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  return Number(value);
}
const minRef = option('--min-ref') ?? 0;
const minSides = option('--min-sides') ?? 0;
const [dir, reportPath] = args;
if (!dir) {
  console.error('usage: reference-check <dir> [report.md] [--min-ref N] [--min-sides N]');
  process.exit(1);
}

function ours(data: ArrayBuffer, name: string) {
  const player = new Player(loadModule(data, name), SR);
  player.playing = true;
  const left: number[] = [];
  const right: number[] = [];
  const l = new Float32Array(1024);
  const r = new Float32Array(1024);
  while (left.length < MAX_SECONDS * SR && player.loops === 0) {
    player.process(l, r);
    left.push(...l);
    right.push(...r);
  }
  return { left: Float32Array.from(left), right: Float32Array.from(right) };
}

function reference(bytes: Uint8Array, name: string, seconds: number) {
  const copy = bytes.slice();
  if (/\.xm$/i.test(name)) new TextEncoder().encodeInto('FastTracker v2.00   ', copy.subarray(38, 58));
  const tmp = mkdtempSync(join(tmpdir(), 'refcheck-'));
  const file = join(tmp, basename(name));
  writeFileSync(file, copy);
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-t', seconds.toFixed(3), '-ar', String(SR), '-ac', '2', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28 },
  );
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = pcm.length / 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = pcm[i * 2]!;
    right[i] = pcm[i * 2 + 1]!;
  }
  return { left, right };
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k);
        const wi = Math.sin(a * k);
        const p = i + k;
        const q = p + len / 2;
        const xr = re[q]! * wr - im[q]! * wi;
        const xi = re[q]! * wi + im[q]! * wr;
        re[q] = re[p]! - xr;
        im[q] = im[p]! - xi;
        re[p] = re[p]! + xr;
        im[p] = im[p]! + xi;
      }
    }
  }
}

const window = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));

function spectrum(signal: Float32Array, at: number) {
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let energy = 0;
  for (let i = 0; i < FRAME; i++) {
    const s = signal[at + i] ?? 0;
    energy += s * s;
    re[i] = s * window[i]!;
  }
  fft(re, im);
  const mag = new Float64Array(FRAME / 2);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.log1p(100 * Math.hypot(re[i]!, im[i]!));
  return { mag, rms: Math.sqrt(energy / FRAME) };
}

/** Mean per-frame log-spectrum cosine similarity; frames silent on both sides count as equal. */
function similarity(a: Float32Array, b: Float32Array) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let frames = 0;
  for (let at = 0; at + FRAME <= n; at += HOP) {
    const x = spectrum(a, at);
    const y = spectrum(b, at);
    frames++;
    const quiet = 1e-3;
    if (x.rms < quiet && y.rms < quiet) {
      sum += 1;
      continue;
    }
    if (x.rms < quiet || y.rms < quiet) continue;
    let dot = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i < x.mag.length; i++) {
      dot += x.mag[i]! * y.mag[i]!;
      xx += x.mag[i]! ** 2;
      yy += y.mag[i]! ** 2;
    }
    sum += dot / Math.sqrt(xx * yy);
  }
  return frames ? sum / frames : 1;
}

const mix = (s: { left: Float32Array; right: Float32Array }) => s.left.map((v, i) => (v + s.right[i]!) / 2);

const files = readdirSync(dir)
  .filter((f) => /\.(xm|mod)$/i.test(f))
  .sort();
const rows: string[] = [];
let vsRef = 0;
let lr = 0;
let either = 0;
let failed = 0;
let previous: Float32Array | undefined;
const control: number[] = [];
for (const f of files) {
  const bytes = new Uint8Array(readFileSync(join(dir, f)));
  try {
    const a = ours(bytes.slice().buffer, f);
    const b = reference(bytes, f, a.left.length / SR);
    const ref = similarity(mix(a), mix(b));
    const sides = similarity(a.left, a.right);
    const mixed = mix(b);
    if (previous) control.push(similarity(mix(a), previous));
    previous = mixed;
    if (ref >= PASS) vsRef++;
    if (sides >= PASS) lr++;
    if (ref >= PASS || sides >= PASS) either++;
    rows.push(`| ${f} | ${ref.toFixed(3)} | ${sides.toFixed(3)} |`);
  } catch (e) {
    failed++;
    rows.push(`| ${f} | error | ${(e as Error).message.split('\n')[0]} |`);
  }
}

const n = files.length;
const summary = [
  `${n} modules in ${basename(dir)}, pass mark ${PASS}:`,
  `- vs libopenmpt: ${vsRef}/${n}`,
  `- left vs right: ${lr}/${n}`,
  `- either: ${either}/${n}`,
  ...(failed ? [`- errors: ${failed}`] : []),
  `- control (each render vs the previous module's reference): mean ${(control.reduce((a, b) => a + b, 0) / (control.length || 1)).toFixed(3)}, ${control.filter((c) => c >= PASS).length}/${control.length} at or above the pass mark`,
].join('\n');
console.log(summary);
if (reportPath) {
  writeFileSync(
    reportPath,
    `${summary}\n\n| Module | vs libopenmpt | left vs right |\n| --- | --- | --- |\n${rows.join('\n')}\n`,
  );
}
if (failed || vsRef < minRef || lr < minSides) {
  console.error(`below the floor: vs libopenmpt needs ${minRef}, left vs right needs ${minSides}, errors must be 0`);
  process.exit(1);
}
