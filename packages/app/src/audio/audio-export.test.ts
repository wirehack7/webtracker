import { describe, expect, it } from 'vitest';
import { parseAudioFormat } from './audio-format.ts';
import { encodeMp3, id3, mp3Rate } from './mp3.ts';

describe('parseAudioFormat', () => {
  it('reads the export dialog values', () => {
    expect(parseAudioFormat('wav:pcm24')).toEqual({ kind: 'wav', format: 'pcm24' });
    expect(parseAudioFormat('flac:24')).toEqual({ kind: 'flac', depth: 24 });
    expect(parseAudioFormat('flac:16')).toEqual({ kind: 'flac', depth: 16 });
    expect(parseAudioFormat('mp3:192')).toEqual({ kind: 'mp3', kbps: 192 });
    expect(parseAudioFormat('pcm16')).toEqual({ kind: 'wav', format: 'pcm16' });
  });
});

describe('encodeMp3', () => {
  it('writes an ID3 tag and then MPEG frames at the chosen bitrate', async () => {
    const rate = 44100;
    const left = new Float32Array(rate * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
    const progress: number[] = [];
    const mp3 = await encodeMp3(left, left, rate, 192, 'Pixel Sunrise', (f) => progress.push(f));
    const tag = id3('Pixel Sunrise');
    expect(mp3.subarray(0, tag.length)).toEqual(tag);
    const header = mp3.subarray(tag.length, tag.length + 4);
    expect(header[0]).toBe(0xff);
    expect(header[1]! & 0xe0).toBe(0xe0);
    // MPEG-1 layer III, bitrate index 11 = 192 kbit/s, 44.1 kHz
    expect(header[2]! >> 4).toBe(11);
    // About two seconds at 192 kbit/s.
    expect(mp3.length).toBeGreaterThan(40000);
    expect(mp3.length).toBeLessThan(60000);
    expect(progress.at(-1)).toBe(1);
  });

  it('caps the rate at 48 kHz', () => {
    expect(mp3Rate(96000)).toBe(48000);
    expect(mp3Rate(44100)).toBe(44100);
  });
});
