import { describe, expect, it } from 'vitest';
import { Column } from '../ui/pattern-view.ts';
import { enterEffect, enterInstrument, enterParam, enterVolume, nextAfterPadKey } from './entry.ts';

describe('instrument entry', () => {
  it('sets high and low digits and stops at 80', () => {
    expect(enterInstrument(0, true, '1')).toBe(0x10);
    expect(enterInstrument(0x10, false, 'a')).toBe(0x1a);
    expect(enterInstrument(0x00, true, 'F')).toBe(0x80);
    expect(enterInstrument(0, true, 'g')).toBeNull();
  });
});

describe('volume entry', () => {
  it('types volumes 00 to 40', () => {
    expect(enterVolume(0, true, '2')).toBe(0x30);
    expect(enterVolume(0x30, false, '8')).toBe(0x38);
    expect(enterVolume(0x50, false, 'F')).toBe(0x50);
    expect(enterVolume(0, true, '5')).toBeNull();
  });

  it('types volume column commands', () => {
    expect(enterVolume(0, true, 'v')).toBe(0xb0);
    expect(enterVolume(0xb0, false, '4')).toBe(0xb4);
    expect(enterVolume(0xb4, true, '+')).toBe(0x74);
    expect(enterVolume(0x30, true, 'm')).toBe(0xf0);
  });
});

describe('effect entry', () => {
  it('maps 0-9 and A-Z', () => {
    expect(enterEffect('0')).toBe(0);
    expect(enterEffect('f')).toBe(15);
    expect(enterEffect('R')).toBe(27);
    expect(enterEffect('-')).toBeNull();
    expect(enterParam(0x00, true, 'c')).toBe(0xc0);
    expect(enterParam(0xc0, false, '3')).toBe(0xc3);
  });
});

describe('touch keypad steps', () => {
  it('fills both digits before moving down', () => {
    expect(nextAfterPadKey(Column.InsHi)).toEqual({ column: Column.InsLo, advance: false });
    expect(nextAfterPadKey(Column.InsLo)).toEqual({ column: Column.InsHi, advance: true });
    expect(nextAfterPadKey(Column.VolHi)).toEqual({ column: Column.VolLo, advance: false });
    expect(nextAfterPadKey(Column.VolLo)).toEqual({ column: Column.VolHi, advance: true });
  });

  it('goes from the effect letter through its parameter', () => {
    expect(nextAfterPadKey(Column.Effect)).toEqual({ column: Column.ParamHi, advance: false });
    expect(nextAfterPadKey(Column.ParamHi)).toEqual({ column: Column.ParamLo, advance: false });
    expect(nextAfterPadKey(Column.ParamLo)).toEqual({ column: Column.Effect, advance: true });
  });
});
