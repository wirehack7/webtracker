import { describe, expect, it } from 'vitest';
import { enterEffect, enterInstrument, enterVolume } from '../editor/entry.ts';
import { padKeys } from './entry-pad.ts';
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
