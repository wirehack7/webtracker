import { describe, expect, it } from 'vitest';
import { noteFrequency, noteName } from './pitch.ts';

describe('noteFrequency', () => {
  it('tunes A-4 to 440 Hz', () => {
    expect(noteFrequency(58)).toBeCloseTo(440, 6);
  });

  it('doubles per octave', () => {
    expect(noteFrequency(70) / noteFrequency(58)).toBeCloseTo(2, 9);
  });
});

describe('noteName', () => {
  it('spells notes like FT2', () => {
    expect(noteName(1)).toBe('C-0');
    expect(noteName(49)).toBe('C-4');
    expect(noteName(58)).toBe('A-4');
    expect(noteName(96)).toBe('B-7');
  });

  it('spells empty and key off', () => {
    expect(noteName(0)).toBe('---');
    expect(noteName(97)).toBe('===');
  });
});
