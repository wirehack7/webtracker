// FT2 piano layout by physical key (KeyboardEvent.code), so QWERTZ, QWERTY and
// AZERTY all get the same keys. Values are semitones above the current octave.
const PIANO: Record<string, number> = {
  // Lower row: C to B of the base octave, then C to E of the next.
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  // Upper row: one octave higher.
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
  KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

const OCTAVE_KEYS: Record<string, number> = {
  F1: 1, F2: 2, F3: 3, F4: 4, F5: 5, F6: 6, F7: 7,
};

/** XM note number (1 = C-0) for a key at the given octave, or null. */
export function noteForKey(code: string, octave: number): number | null {
  const semitone = PIANO[code];
  if (semitone === undefined) return null;
  const note = octave * 12 + semitone + 1;
  return note >= 1 && note <= 96 ? note : null;
}

// Relative octave keys for keyboards where the F keys are media keys.
const OCTAVE_STEPS: Record<string, number> = { NumpadDivide: -1, NumpadMultiply: 1 };
const CTRL_OCTAVE_STEPS: Record<string, number> = { ArrowDown: -1, ArrowUp: 1 };
const MAX_OCTAVE = 7;

/** The octave a key selects (F1–F7, Numpad / and *, Ctrl+Up/Down), or null. */
export function octaveForKey(code: string, current: number, ctrl = false): number | null {
  if (ctrl) {
    const step = CTRL_OCTAVE_STEPS[code];
    return step === undefined ? null : Math.max(0, Math.min(MAX_OCTAVE, current + step));
  }
  const step = OCTAVE_STEPS[code];
  if (step !== undefined) return Math.max(0, Math.min(MAX_OCTAVE, current + step));
  return OCTAVE_KEYS[code] ?? null;
}
