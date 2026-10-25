import { describe, expect, it } from 'vitest';
import { midiToNote, parseColors, uiPixel, velocityToVolume } from './settings.ts';

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

describe('uiPixel', () => {
  it('rounds to whole device pixels', () => {
    expect(uiPixel('compact', false, 1)).toBe(1);
    expect(uiPixel('large', false, 1)).toBe(2);
    expect(uiPixel('compact', false, 2)).toBe(1.5);
    expect(uiPixel('compact', false, 1.25)).toBe(1.6);
    expect(uiPixel('small', false, 1.5)).toBe(4 / 3);
    expect(uiPixel('medium', false, 1)).toBe(2);
  });

  it('stops at medium below 1280px', () => {
    expect(uiPixel('large', false, 2, 1279)).toBe(1.5);
    expect(uiPixel('large', false, 2, 1280)).toBe(2);
    expect(uiPixel('medium', true, 1, 1024)).toBe(1);
  });

  it('picks compact with a mouse and medium on tablets', () => {
    expect(uiPixel('auto', false, 2)).toBe(uiPixel('compact', false, 2));
    expect(uiPixel('auto', true, 2)).toBe(uiPixel('medium', false, 2));
  });

  it('never goes below one device pixel', () => {
    expect(uiPixel('small', false, 0.5)).toBe(2);
    expect(uiPixel('small', false, 0)).toBe(1);
  });
});
