// Names of the undoable edits, as the status line shows them after Undo and
// Redo. The editor keeps its labels in English, since the code compares them;
// they are listed here so the language packs can translate them.

import { msg, t } from './i18n.ts';

export const EDIT_NAMES = [
  // Pattern
  msg('note'),
  msg('entry'),
  msg('clear'),
  msg('cut'),
  msg('paste'),
  msg('cut block'),
  msg('cut track'),
  msg('cut pattern'),
  msg('paste block'),
  msg('paste track'),
  msg('paste pattern'),
  msg('transpose'),
  msg('interpolate'),
  msg('key off'),
  msg('insert row'),
  msg('delete row'),
  msg('length'),
  msg('load pattern'),
  msg('load track'),
  msg('remap instrument'),
  msg('scale volume'),
  // Song
  msg('title'),
  msg('channels'),
  msg('clean up'),
  msg('insert position'),
  msg('delete position'),
  msg('pattern number'),
  msg('new pattern'),
  msg('clone pattern'),
  // Instruments
  msg('name'),
  msg('load instrument'),
  msg('load sample'),
  msg('envelope'),
  msg('envelope on'),
  msg('envelope loop'),
  msg('envelope preset'),
  msg('paste envelope'),
  msg('sustain'),
  msg('sustain point'),
  msg('loop start'),
  msg('loop end'),
  msg('delete point'),
  msg('fadeout'),
  msg('vibrato'),
  msg('keymap'),
  // Samples
  msg('volume'),
  msg('panning'),
  msg('finetune'),
  msg('relativeNote'),
  msg('loop'),
  msg('draw'),
  msg('generate'),
  msg('crop'),
  msg('silence'),
  msg('reverse'),
  msg('normalize'),
  msg('amplify'),
  msg('fade in'),
  msg('fade out'),
  msg('resample'),
  msg('invert'),
  msg('sign'),
  msg('byte swap'),
  msg('DC offset'),
  msg('8-bit'),
  msg('lowpass'),
  msg('highpass'),
  msg('crossfade loop'),
];

/** An edit label in the chosen language; labels not listed above show as they are. */
export function editName(label: string): string {
  return t(label);
}
