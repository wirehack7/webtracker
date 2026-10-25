import { describe, expect, it } from 'vitest';
import { midiToNote, parseColors, velocityToVolume } from './settings.ts';

describe('MIDI mapping', () => {
  it('puts MIDI 60 on C-4 and drops notes outside the tracker range', () => {
    expect(midiToNote(60)).toBe(49);
    expect(midiToNote(12)).toBe(1);
    expect(midiToNote(107)).toBe(96);
    expect(midiToNote(11)).toBeNull();
    expect(midiToNote(108)).toBeNull();
  });

  it('scales velocity to the volume column', () => {
    expect(velocityToVolume(127)).toBe(0x50);
    expect(velocityToVolume(64)).toBe(0x10 + 32);
    expect(velocityToVolume(1)).toBe(0x11);
  });
});

describe('parseColors', () => {
  it('keeps known properties with hex colours only', () => {
    expect(parseColors({ '--desk': '#AABBCC', '--pat-bg': 'red', '--evil': '#000000', '--text': 5 })).toEqual({ '--desk': '#aabbcc' });
    expect(parseColors(null)).toEqual({});
    expect(parseColors('x')).toEqual({});
  });
});
