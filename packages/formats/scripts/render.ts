/**
 * Offline renderer: plays a module through the same Player the worklet uses
 * and writes a 16-bit stereo WAV.
 *
 *   pnpm render song.xm [out.wav] [seconds]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Player } from '@webtracker/engine';
import { loadModule } from '../src/index.ts';

const [input, outputArg, secondsArg] = process.argv.slice(2);
if (!input) {
  console.error('usage: pnpm render <module> [out.wav] [seconds]');
  process.exit(1);
}
const output = outputArg ?? input.replace(/\.[^.]+$/, '') + '.wav';

const sampleRate = 44100;
const file = readFileSync(input);
const song = loadModule(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), basename(input));
const player = new Player(song, sampleRate);
player.playing = true;

const maxSeconds = secondsArg ? Number(secondsArg) : 600;
const block = 1024;
const left = new Float32Array(block);
const right = new Float32Array(block);
const chunks: Int16Array[] = [];
let frames = 0;
// Without an explicit length, stop when the song loops for the first time.
while (frames < maxSeconds * sampleRate && (secondsArg || player.loops === 0)) {
  player.process(left, right);
  const pcm = new Int16Array(block * 2);
  for (let i = 0; i < block; i++) {
    pcm[i * 2] = Math.round(left[i]! * 32767);
    pcm[i * 2 + 1] = Math.round(right[i]! * 32767);
  }
  chunks.push(pcm);
  frames += block;
}

const dataBytes = frames * 4;
const wav = Buffer.alloc(44 + dataBytes);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataBytes, 40);
let o = 44;
for (const c of chunks) {
  Buffer.from(c.buffer).copy(wav, o);
  o += c.byteLength;
}
writeFileSync(output, wav);
console.log(`${song.formatName} "${song.title}": ${song.channels} ch, ${(frames / sampleRate).toFixed(1)} s -> ${output}`);
