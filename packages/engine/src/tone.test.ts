import { describe, expect, it } from 'vitest';
import { ToneVoice } from './tone.ts';

const RATE = 48000;

function render(voice: ToneVoice, frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  voice.mix(left, right, frames);
  return { left, right };
}

describe('ToneVoice', () => {
  it('is silent until a note starts', () => {
    const { left } = render(new ToneVoice(RATE), 128);
    expect(left.every((s) => s === 0)).toBe(true);
  });

  it('plays the requested frequency', () => {
    const voice = new ToneVoice(RATE);
    voice.noteOn(480);
    const { left } = render(voice, RATE);
    let rising = 0;
    for (let i = 1; i < left.length; i++) {
      if (left[i - 1]! <= 0 && left[i]! > 0) rising++;
    }
    expect(rising).toBeGreaterThanOrEqual(479);
    expect(rising).toBeLessThanOrEqual(481);
  });

  it('ramps in instead of jumping to full level', () => {
    const voice = new ToneVoice(RATE, 0.005, 0.5, 0.2);
    voice.noteOn(440);
    const { left } = render(voice, 4);
    expect(Math.abs(left[0]!)).toBeLessThan(0.01);
  });

  it('fades out and goes idle after note off', () => {
    const voice = new ToneVoice(RATE);
    voice.noteOn(440);
    render(voice, 1024);
    voice.noteOff();
    render(voice, 1024);
    expect(voice.active).toBe(false);
    const { left } = render(voice, 128);
    expect(left.every((s) => s === 0)).toBe(true);
  });

  it('writes the same signal to both channels', () => {
    const voice = new ToneVoice(RATE);
    voice.noteOn(440);
    const { left, right } = render(voice, 512);
    expect(Array.from(right)).toEqual(Array.from(left));
  });
});
