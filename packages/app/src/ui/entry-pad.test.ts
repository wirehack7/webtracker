// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { enterEffect, enterInstrument, enterVolume } from '../editor/entry.ts';
import { padKeys, renderPadKeys } from './entry-pad.ts';
import { Column } from './pattern-view.ts';

const usable = (column: number, effect = 0) => padKeys(column, effect).filter((k) => !k.disabled).map((k) => k.key);

describe('touch keypad', () => {
  it('offers only keys the column takes', () => {
    for (const key of usable(Column.Effect)) expect(enterEffect(key)).not.toBeNull();
    for (const key of usable(Column.VolHi)) expect(enterVolume(0, true, key)).not.toBeNull();
    expect(usable(Column.VolHi)).toHaveLength(15);
    expect(usable(Column.InsHi).at(-1)).toBe('8');
    expect(enterInstrument(0, true, '8')).toBe(0x80);
    expect(usable(Column.ParamLo)).toHaveLength(16);
  });

  it('names the extended effects on the first parameter digit of Exy', () => {
    expect(padKeys(Column.ParamHi, 0x0e)[0xc]?.hint).toBe('Cut');
    expect(padKeys(Column.ParamHi, 0x0a)[0xc]?.hint).toBeUndefined();
  });
});

describe('keypad buttons', () => {
  it('makes a button per key with its hint, and lays them out by count', () => {
    const pad = document.createElement('div');
    renderPadKeys(pad, padKeys(Column.InsHi, 0));
    const keys = [...pad.querySelectorAll('button')];
    expect(keys.map((b) => b.dataset.key).join('')).toBe('0123456789ABCDEF');
    expect(keys.filter((b) => b.disabled).map((b) => b.dataset.key).join('')).toBe('9ABCDEF');
    expect(pad.style.getPropertyValue('--pad-cols')).toBe('8');
    expect(pad.style.getPropertyValue('--pad-cols-wide')).toBe('8');

    renderPadKeys(pad, padKeys(Column.Effect, 0));
    expect(pad.style.getPropertyValue('--pad-cols')).toBe('7');
    expect(pad.querySelector('[data-key="C"] small')!.textContent).toBe('Vol');

    renderPadKeys(pad, padKeys(Column.VolHi, 0));
    expect(pad.style.getPropertyValue('--pad-cols')).toBe('5');
    expect(pad.querySelector('[data-key="0"] small')).toBeNull();
  });
});
