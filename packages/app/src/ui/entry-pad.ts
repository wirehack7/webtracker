// Keys for the touch keypad that takes the piano's place while the cursor
// is in the instrument, volume or effect column: hex digits, volume column
// commands or effect letters, each with a short hint of what it does.

import { Column, VOLUME_COMMANDS } from './pattern-view.ts';

export interface PadKey {
  /** What the key types, as a keyboard would. */
  key: string;
  hint?: string;
  disabled?: boolean;
}

const HEX = '0123456789ABCDEF';

const EFFECT_HINTS: Record<string, string> = {
  '0': 'Arp', '1': 'Up', '2': 'Down', '3': 'Port', '4': 'Vib', '5': 'P+Vs', '6': 'V+Vs', '7': 'Trem',
  '8': 'Pan', '9': 'Offs', A: 'VSld', B: 'Jump', C: 'Vol', D: 'Brk', E: 'Ext', F: 'Spd',
  G: 'GVol', H: 'GVSl', K: 'KOff', L: 'Env', M: 'ChV', N: 'ChVS', P: 'PSld', R: 'Retr', T: 'Trmr', X: 'XFin',
};

// The first digit of Exy picks one of the extended effects.
const EXTENDED_HINTS = ['Filt', 'FUp', 'FDn', 'Glis', 'VibW', 'Tune', 'Loop', 'TrmW', 'Pan', 'Retr', 'FVUp', 'FVDn', 'Cut', 'Dly', 'PDly', 'Inv'];

const VOLUME_HINTS = ['SlDn', 'SlUp', 'FnDn', 'FnUp', 'VbSp', 'Vib', 'Pan', 'PnL', 'PnR', 'Port'];

const hexKeys = (hints: readonly string[] = [], enabled = 16): PadKey[] =>
  [...HEX].map((key, i) => ({ key, ...(hints[i] ? { hint: hints[i] } : {}), ...(i >= enabled ? { disabled: true } : {}) }));

/** The keys for the cursor column; `effect` is the effect already in the cell. */
export function padKeys(column: number, effect: number): PadKey[] {
  switch (column) {
    case Column.InsHi:
      // Instruments end at 80.
      return hexKeys([], 9);
    case Column.VolHi:
      // Volumes 00 to 40, or a command with its value in the second digit.
      return [
        ...[...'01234'].map((key) => ({ key })),
        ...[...VOLUME_COMMANDS].map((key, i) => ({ key, hint: VOLUME_HINTS[i]! })),
      ];
    case Column.Effect:
      return Object.entries(EFFECT_HINTS).map(([key, hint]) => ({ key, hint }));
    case Column.ParamHi:
      return hexKeys(effect === 0x0e ? EXTENDED_HINTS : []);
    default:
      return hexKeys();
  }
}

/** Fills `container` with buttons for `keys`; a tap on one sends its key. */
export function renderPadKeys(container: HTMLElement, keys: PadKey[]): void {
  container.style.setProperty('--pad-cols', String(keys.length > 16 ? 7 : keys.length === 15 ? 5 : 8));
  // Two rows where the screen is wide and low.
  container.style.setProperty('--pad-cols-wide', String(Math.ceil(keys.length / 2)));
  container.replaceChildren(
    ...keys.map((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn pad-key';
      b.dataset.key = k.key;
      b.disabled = k.disabled === true;
      const main = document.createElement('span');
      main.textContent = k.key;
      b.append(main);
      if (k.hint) {
        const hint = document.createElement('small');
        hint.textContent = k.hint;
        b.append(hint);
      }
      return b;
    }),
  );
}
