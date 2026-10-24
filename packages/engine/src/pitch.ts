/** A-4 in XM note numbering (1 = C-0). */
const NOTE_A4 = 58;

/** Equal-tempered frequency of an XM note, A-4 = 440 Hz. */
export function noteFrequency(note: number): number {
  return 440 * 2 ** ((note - NOTE_A4) / 12);
}

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/** Tracker spelling of a note: 1 → "C-0", 97 → "===", 0 → "---". */
export function noteName(note: number): string {
  if (note === 0) return '---';
  if (note === 97) return '===';
  const n = note - 1;
  return `${NAMES[n % 12]}${Math.floor(n / 12)}`;
}
