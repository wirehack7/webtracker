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
    expect(octaveForKey('F1', 4)).toBe(1);
    expect(octaveForKey('F7', 4)).toBe(7);
    expect(octaveForKey('F8', 4)).toBeNull();
  });

  it('steps with Numpad / and * and Ctrl+Up/Down, within 0 to 7', () => {
    expect(octaveForKey('NumpadDivide', 4)).toBe(3);
    expect(octaveForKey('NumpadMultiply', 4)).toBe(5);
    expect(octaveForKey('NumpadMultiply', 7)).toBe(7);
    expect(octaveForKey('ArrowDown', 0, true)).toBe(0);
    expect(octaveForKey('ArrowUp', 4, true)).toBe(5);
    expect(octaveForKey('ArrowUp', 4)).toBeNull();
    expect(octaveForKey('F2', 4, true)).toBeNull();
  });
});
