// Turns keys typed into the instrument, volume and effect columns into cell
// values. Volume bytes follow XM: 0x10..0x50 set volume 0..64, 0x60..0xF0
// are commands whose first character comes from VOLUME_COMMANDS.

import { VOLUME_COMMANDS } from '../ui/pattern-view.ts';

const HEX = '0123456789ABCDEF';
const EFFECTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function hexDigit(key: string): number | null {
  const i = key.length === 1 ? HEX.indexOf(key.toUpperCase()) : -1;
  return i < 0 ? null : i;
}

function setNibble(value: number, high: boolean, digit: number): number {
  return high ? (digit << 4) | (value & 0x0f) : (value & 0xf0) | digit;
}

/** Instrument number after typing a hex digit; XM has 128 instruments. */
export function enterInstrument(current: number, high: boolean, key: string): number | null {
  const d = hexDigit(key);
  return d === null ? null : Math.min(0x80, setNibble(current, high, d));
}

/** Volume column byte after typing `key`, or null if the key means nothing there. */
export function enterVolume(current: number, high: boolean, key: string): number | null {
  const isVolume = current >= 0x10 && current <= 0x50;
  const isCommand = current >= 0x60;
  if (high) {
    const command = VOLUME_COMMANDS.indexOf(key.toUpperCase());
    if (command >= 0 && key.length === 1) return ((command + 6) << 4) | (isCommand ? current & 0x0f : 0);
    const d = hexDigit(key);
    if (d === null || d > 4) return null;
    const volume = isVolume ? current - 0x10 : 0;
    return Math.min(0x40, setNibble(volume, true, d)) + 0x10;
  }
  const d = hexDigit(key);
  if (d === null) return null;
  if (isCommand) return setNibble(current, false, d);
  const volume = isVolume ? current - 0x10 : 0;
  return Math.min(0x40, setNibble(volume, false, d)) + 0x10;
}

/** Effect number for a typed character (0-9, A-Z as in FT2). */
export function enterEffect(key: string): number | null {
  const i = key.length === 1 ? EFFECTS.indexOf(key.toUpperCase()) : -1;
  return i < 0 ? null : i;
}

export function enterParam(current: number, high: boolean, key: string): number | null {
  const d = hexDigit(key);
  return d === null ? null : setNibble(current, high, d);
}
