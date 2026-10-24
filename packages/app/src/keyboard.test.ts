import { describe, expect, it } from 'vitest';
import { noteName } from '@webtracker/engine';
import { noteForKey, octaveForKey } from './keyboard.ts';

describe('noteForKey', () => {
  it('maps the lower row to the base octave', () => {
    expect(noteName(noteForKey('KeyZ', 4)!)).toBe('C-4');
    expect(noteName(noteForKey('KeyM', 4)!)).toBe('B-4');
  });

  it('maps the upper row one octave higher', () => {
    expect(noteName(noteForKey('KeyQ', 4)!)).toBe('C-5');
    expect(noteName(noteForKey('Digit2', 4)!)).toBe('C#5');
  });

  it('ignores keys outside the piano and notes past B-7', () => {
    expect(noteForKey('KeyA', 4)).toBeNull();
    expect(noteForKey('KeyP', 7)).toBeNull();
  });
});

describe('octaveForKey', () => {
  it('selects octaves with F1 to F7', () => {
    expect(octaveForKey('F1')).toBe(1);
    expect(octaveForKey('F7')).toBe(7);
    expect(octaveForKey('F8')).toBeNull();
  });
});
