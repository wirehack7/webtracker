// Text of the Help dialog: keys, effect and volume column reference, other
// formats and workflows. Plain data, so it can be searched and tested.

import { formatEffect, formatVolume } from './pattern-view.ts';

export interface HelpEntry {
  /** What to press or type, e.g. "Ctrl+Z" or "Axy". */
  code: string;
  name?: string;
  text: string;
  /** Stable id for linking from the pattern cursor, e.g. "fx-A" or "vol-S". */
  id?: string;
  /** A page that goes with the entry, relative to the tracker. */
  link?: { href: string; label: string };
}

export interface HelpGroup {
  title?: string;
  intro?: string;
  entries: HelpEntry[];
}

export interface HelpSection {
  id: string;
  title: string;
  groups: HelpGroup[];
}

const KEYS: HelpSection = {
  id: 'keys',
  title: 'Keys',
  groups: [
    {
      title: 'Notes and octaves',
      entries: [
        { code: 'Z S X … M', text: 'Notes, lower octave (physical keys, any layout)' },
        { code: 'Q 2 W … U', text: 'Notes, upper octave' },
        { code: 'F1 – F7', text: 'Choose octave' },
        { code: 'Numpad / *, Ctrl+Up/Down', text: 'Octave down / up' },
        { code: '1 or `', text: 'Key off (stops the note, the envelope goes into its release)' },
        {
          code: 'Piano',
          text: 'Hold a key and drag, drag the octave strip, swipe with two fingers, tap a C label or use the arrows to reach other octaves',
        },
      ],
    },
    {
      title: 'Playing',
      entries: [
        { code: 'Space', text: 'Stop, or toggle edit mode (Rec); Setup can switch it to play/stop with Shift+Space for edit mode' },
        { code: 'Enter', text: 'Play song from the current position' },
        { code: 'Shift+Enter', text: 'Play the current pattern' },
        { code: 'Ctrl+Enter', text: 'Play the pattern from the cursor row (Shift: the song)' },
        { code: 'Alt+Enter', text: 'Play only the cursor row and move down one row' },
        { code: 'Ctrl+F', text: 'Follow song on or off' },
        { code: 'Shift+M / Shift+U', text: 'Mute or unmute the cursor channel / unmute all' },
        { code: 'Scopes', text: 'Click to mute a channel, right-click to solo it' },
      ],
    },
    {
      title: 'Moving around',
      entries: [
        { code: 'Arrows', text: 'Move the cursor; PgUp/PgDn 16 rows, Home/End' },
        { code: 'Tab', text: 'Next channel, Shift+Tab previous' },
        { code: 'F9 – F12', text: 'Jump to row 0, 1/4, 1/2, 3/4 of the pattern' },
        { code: 'Alt+Q … I, Alt+A … K', text: 'Jump to channel 1–8, 9–16' },
        { code: 'Alt+PgUp / PgDn', text: 'Previous / next song tab' },
      ],
    },
    {
      title: 'Editing',
      entries: [
        { code: '0-9 A-F', text: 'Instrument, volume, effect and parameter digits in edit mode' },
        { code: 'G-Z', text: 'In the effect column: effects G to Z; in the volume column the letters - + D U S V P L R M' },
        { code: 'Del', text: 'Clear the field under the cursor, or the selection' },
        { code: 'Ins / Backspace', text: 'Insert a row / delete the row above (Shift: all channels)' },
        { code: 'Shift+Arrows', text: 'Select a block, also by dragging with the mouse' },
        { code: 'Ctrl+C X V', text: 'Copy, cut, paste; Ctrl+Shift+V pastes into empty fields only' },
        { code: 'Ctrl+A', text: 'Select the whole pattern; Esc clears the selection' },
        { code: 'Alt+Up/Down', text: 'Transpose the selection or cell a semitone (Shift: octave)' },
        { code: 'Ctrl+I', text: 'Interpolate the volume column or effect under the cursor across the selection' },
        { code: 'Ctrl+E', text: 'Advanced Edit: transpose with instrument filter, remap instruments, scale volume, clean up the song' },
        { code: 'Shift+F3 / F4 / F5', text: 'Cut / copy / paste the track' },
        { code: 'Ctrl+F3 / Ctrl+Shift+F4 / Ctrl+F5', text: 'Cut / copy / paste the pattern (Ctrl+F4 belongs to the browser)' },
        { code: 'Alt+F3 / Alt+F5', text: 'Cut / paste the selection (copy is Ctrl+C)' },
        { code: 'Ctrl+Z / Ctrl+Y', text: 'Undo / redo' },
      ],
    },
    {
      title: 'Files and panels',
      entries: [
        { code: 'Ctrl+S / Ctrl+O', text: 'Save as XM / load a module; the Save button also saves MOD and exports WAV, FLAC or MP3' },
        { code: 'Setup', text: 'Colours and the colour editor, interface size, resampling, stereo width, amplification, volume ramps, MOD E8x, row highlights, Space key, MIDI keyboard input' },
        { code: 'Sample view', text: 'Drag to select, drag the yellow markers to move the loop, double-click selects all' },
        { code: 'Instr view', text: 'Click to add envelope points, drag to move, right-click to delete' },
        {
          code: 'Drop a file',
          text: 'A module (MOD, XM, S3M, IT, MTM, 669, OKT, also zipped or packed) opens as a song; XP/XT goes into the pattern; WAV, AIFF, FLAC, MP3, OGG, 8SVX, XI or PAT goes into the current sample slot',
        },
      ],
    },
  ],
};

const BASICS: HelpGroup = {
  title: 'How effects work',
  intro:
    'A row lasts Speed ticks (Spd, 6 by default); a tick lasts 2.5 / BPM seconds, so Speed 6 at 125 BPM gives 120 ms per row. ' +
    'Most effects act on every tick except the first (slides, vibrato), some only on the first (set volume, fine slides). ' +
    'The effect column shows the effect as one character and its parameter as two hex digits: in "xy" each digit is a value of its own, "xx" is one byte. ' +
    'An effect with parameter 00 usually repeats the last value used with it on that channel (effect memory).',
  entries: [],
};

const EFFECTS: HelpGroup = {
  title: 'Effect column',
  entries: [
    { id: 'fx-0', code: '0xy', name: 'Arpeggio', text: 'Plays the note, the note + x semitones and the note + y semitones in turn, one per tick. 037 gives a minor chord, 047 a major one, 0C0 an octave trill.' },
    { id: 'fx-1', code: '1xx', name: 'Portamento up', text: 'Slides the pitch up by xx on every tick but the first. In XM 100 repeats the last speed; in MOD 100 does nothing.' },
    { id: 'fx-2', code: '2xx', name: 'Portamento down', text: 'Slides the pitch down by xx on every tick but the first.' },
    { id: 'fx-3', code: '3xx', name: 'Tone portamento', text: 'Glides from the playing note to the note in this row at speed xx instead of starting it again. 300 keeps gliding at the last speed. See E3x for semitone steps.' },
    { id: 'fx-4', code: '4xy', name: 'Vibrato', text: 'Wobbles the pitch with speed x and depth y. A zero digit keeps the last value, so 400 continues the vibrato. E4x picks the waveform.' },
    { id: 'fx-5', code: '5xy', name: 'Tone portamento + volume slide', text: 'Continues the tone portamento (as 300) and slides the volume like Axy.' },
    { id: 'fx-6', code: '6xy', name: 'Vibrato + volume slide', text: 'Continues the vibrato (as 400) and slides the volume like Axy.' },
    { id: 'fx-7', code: '7xy', name: 'Tremolo', text: 'Wobbles the volume with speed x and depth y. E7x picks the waveform.' },
    { id: 'fx-8', code: '8xx', name: 'Set panning', text: '00 is hard left, 80 centre, FF hard right. ProTracker ignores it, so it does nothing in MOD songs.' },
    { id: 'fx-9', code: '9xx', name: 'Sample offset', text: 'Starts the note xx × 256 sample frames into the sample. Only works together with a note. Handy for drum loops and speech.' },
    { id: 'fx-A', code: 'Axy', name: 'Volume slide', text: 'Slides the volume up by x or down by y on every tick but the first. Use only one digit: A40 fades in, A04 fades out. A00 repeats the last slide.' },
    { id: 'fx-B', code: 'Bxx', name: 'Position jump', text: 'After this row the song continues at order position xx. B00 at the end of the song loops it.' },
    { id: 'fx-C', code: 'Cxx', name: 'Set volume', text: 'Sets the note volume, 00 to 40 (hex, 40 = full).' },
    { id: 'fx-D', code: 'Dxx', name: 'Pattern break', text: 'Ends the pattern after this row and starts the next one at row xx. The digits are decimal: D10 starts at row 10, not 16.' },
    { id: 'fx-F', code: 'Fxx', name: 'Set speed / BPM', text: '01 to 1F set the speed (ticks per row), 20 to FF the BPM. F00 does nothing.' },
    { id: 'fx-G', code: 'Gxx', name: 'Set global volume', text: 'Volume of the whole song, 00 to 40. XM only.' },
    { id: 'fx-H', code: 'Hxy', name: 'Global volume slide', text: 'Slides the global volume up by x or down by y per tick. XM only.' },
    { id: 'fx-K', code: 'Kxx', name: 'Key off', text: 'Releases the note at tick xx, as a key off in the note column would. XM only.' },
    { id: 'fx-L', code: 'Lxx', name: 'Set envelope position', text: 'Jumps the volume envelope of the instrument to tick xx (the panning envelope follows only when the volume envelope has sustain on, as in FastTracker 2). XM only.' },
    { id: 'fx-M', code: 'Mxx', name: 'Channel volume', text: 'Sets the volume of the channel, 00 to 40, on top of the note volume. Comes from IT; other XM players ignore it.' },
    { id: 'fx-N', code: 'Nxy', name: 'Channel volume slide', text: 'Slides the channel volume up by x or down by y per tick; NxF and NFy are fine slides on the first tick. Comes from IT; other XM players ignore it.' },
    { id: 'fx-P', code: 'Pxy', name: 'Panning slide', text: 'Slides the panning right by x or left by y per tick. XM only.' },
    { id: 'fx-R', code: 'Rxy', name: 'Multi retrigger', text: 'Restarts the note every y ticks and changes its volume by x each time: 1–5 subtract 1, 2, 4, 8, 16; 6 = ×2/3; 7 = ×1/2; 9–D add 1, 2, 4, 8, 16; E = ×3/2; F = ×2; 0 and 8 keep it. XM only.' },
    { id: 'fx-T', code: 'Txy', name: 'Tremor', text: 'Switches the note on for x + 1 ticks and off for y + 1 ticks, over and over. XM only.' },
    { id: 'fx-X', code: 'X1y / X2y', name: 'Extra fine portamento', text: 'Slides the pitch up (X1y) or down (X2y) by y quarter steps once, on the first tick. XM only.' },
  ],
};

const EXTENDED: HelpGroup = {
  title: 'Extended effects (Exy)',
  entries: [
    { id: 'fx-E0', code: 'E0x', name: 'Amiga filter', text: 'MOD only: E00 switches the Amiga LED low-pass filter on, E01 off. You hear it with the Amiga resampler (Setup).' },
    { id: 'fx-E1', code: 'E1x', name: 'Fine portamento up', text: 'Slides the pitch up by x once, on the first tick.' },
    { id: 'fx-E2', code: 'E2x', name: 'Fine portamento down', text: 'Slides the pitch down by x once, on the first tick.' },
    { id: 'fx-E3', code: 'E3x', name: 'Glissando control', text: 'E31 makes tone portamento (3xx) move in semitone steps, E30 smooth again.' },
    { id: 'fx-E4', code: 'E4x', name: 'Vibrato waveform', text: '0 sine, 1 ramp down, 2 square. Add 4 to keep the vibrato position when a new note starts.' },
    { id: 'fx-E5', code: 'E5x', name: 'Set finetune', text: 'Tunes the note in this row in 1/8 semitone steps. XM: 8 is in tune, 0–7 flatter, 9–F sharper. MOD: 0 is in tune, 1–7 sharper, 8–F flatter.' },
    { id: 'fx-E6', code: 'E6x', name: 'Pattern loop', text: 'E60 marks the loop start, E6x on a later row plays the rows in between x more times. Each channel has its own loop.' },
    { id: 'fx-E7', code: 'E7x', name: 'Tremolo waveform', text: 'As E4x, for the tremolo.' },
    { id: 'fx-E8', code: 'E8x', name: 'Set panning (coarse)', text: '0 is left, 8 about centre, F right. MOD: ProTracker\'s Karplus-Strong filter instead, which smooths the sample loop on every tick. Most MODs use E8x only as a demo sync marker, so it is off unless switched on in Setup.' },
    { id: 'fx-E9', code: 'E9x', name: 'Retrigger note', text: 'Restarts the note every x ticks; with speed 6, E93 plays it twice per row. Good for drum rolls.' },
    { id: 'fx-EA', code: 'EAx', name: 'Fine volume slide up', text: 'Raises the volume by x once, on the first tick.' },
    { id: 'fx-EB', code: 'EBx', name: 'Fine volume slide down', text: 'Lowers the volume by x once, on the first tick.' },
    { id: 'fx-EC', code: 'ECx', name: 'Note cut', text: 'Sets the volume to 0 at tick x. EC0 silences it at once. Short, punchy hi-hats and chip blips.' },
    { id: 'fx-ED', code: 'EDx', name: 'Note delay', text: 'Starts the note in this row x ticks late, for swing and flams.' },
    { id: 'fx-EE', code: 'EEx', name: 'Pattern delay', text: 'Holds the song on this row for x more rows; effects keep running.' },
    { id: 'fx-EF', code: 'EFx', name: 'Invert loop', text: 'MOD only: ProTracker\'s "funk repeat" flips one byte of the sample loop at a time, x sets how fast (F is once per tick). The song\'s sample stays unchanged.' },
  ],
};

const VOLUME: HelpGroup = {
  title: 'Volume column',
  intro:
    'XM songs have a second, smaller effect column next to the instrument. Type 0–4 for a volume or one of the letters for a command; the digit after it is the value (0–F). ' +
    'It works together with the effect column, so a note can have a volume and an effect at once.',
  entries: [
    { id: 'vol-set', code: '00 – 40', name: 'Set volume', text: 'Sets the note volume (hex, 40 = full), like Cxx.' },
    { id: 'vol--', code: '-x', name: 'Volume slide down', text: 'Lowers the volume by x on every tick but the first, like A0x.' },
    { id: 'vol-+', code: '+x', name: 'Volume slide up', text: 'Raises the volume by x on every tick but the first, like Ax0.' },
    { id: 'vol-D', code: 'Dx', name: 'Fine volume down', text: 'Lowers the volume by x once, like EBx.' },
    { id: 'vol-U', code: 'Ux', name: 'Fine volume up', text: 'Raises the volume by x once, like EAx.' },
    { id: 'vol-S', code: 'Sx', name: 'Vibrato speed', text: 'Sets the vibrato speed without vibrating; use Vx or 4xy to start it.' },
    { id: 'vol-V', code: 'Vx', name: 'Vibrato', text: 'Vibrates with depth x at the speed set last.' },
    { id: 'vol-P', code: 'Px', name: 'Set panning', text: '0 is left, 8 centre, F right.' },
    { id: 'vol-L', code: 'Lx', name: 'Panning slide left', text: 'Moves the panning left by x on every tick but the first.' },
    { id: 'vol-R', code: 'Rx', name: 'Panning slide right', text: 'Moves the panning right by x on every tick but the first.' },
    { id: 'vol-M', code: 'Mx', name: 'Tone portamento', text: 'Glides to the note at speed x × 16 (as 3xx), leaving the effect column free.' },
  ],
};

const EFFECT_SECTION: HelpSection = { id: 'effects', title: 'Effects', groups: [BASICS, EFFECTS, EXTENDED, VOLUME] };

const FORMATS: HelpSection = {
  id: 'formats',
  title: 'Formats',
  groups: [
    {
      title: 'MOD',
      intro:
        'MOD songs play like ProTracker 2 on an Amiga, quirks included. They have effects 0–F only (no G–X), no volume column, and up to 32 channels. ' +
        'Volumes entered in the volume column still play, but are not part of the MOD format. 8xx (panning) and EFx do nothing; E0x switches the Amiga filter.',
      entries: [],
    },
    {
      title: 'XM',
      intro:
        'XM is the native format: every effect in the reference plays as in FastTracker 2. Mxx and Nxy are extras taken from IT that other XM players ignore.',
      entries: [],
    },
    {
      title: 'S3M',
      intro: 'S3M songs are turned into XM effects when they load. The S3M letters map like this:',
      entries: [
        { code: 'Axx', text: 'Speed → Fxx (below 20)' },
        { code: 'Bxx, Cxx', text: 'Position jump → Bxx, pattern break → Dxx' },
        { code: 'Dxy', text: 'Volume slide → Axy; DFx / DxF fine slides → EBx / EAx' },
        { code: 'Exx, Fxx', text: 'Portamento down / up → 2xx / 1xx; EFx / FFx fine → E2x / E1x; EEx / FEx extra fine → X2x / X1x' },
        { code: 'Gxx, Hxy, Uxy', text: 'Tone portamento → 3xx, vibrato → 4xy, fine vibrato → 4xy with a quarter of the depth' },
        { code: 'Ixy', text: 'Tremor → Txy' },
        { code: 'Jxy', text: 'Arpeggio → 0xy' },
        { code: 'Kxy, Lxy', text: 'Vibrato + slide → 6xy, tone portamento + slide → 5xy' },
        { code: 'Oxx', text: 'Sample offset → 9xx' },
        { code: 'Qxy, Rxy', text: 'Retrigger → Rxy, tremolo → 7xy' },
        { code: 'S1x – SEx', text: 'Glissando E3x, finetune E5x, vibrato / tremolo waveform E4x / E7x, panning 8xx, loop E6x, note cut ECx, note delay EDx, pattern delay EEx' },
        { code: 'Txx', text: 'Tempo → Fxx (20 and up; tempo slides are dropped)' },
        { code: 'Vxx', text: 'Global volume → Gxx' },
        { code: 'Xxx', text: 'Panning 00–80 → 8xx (surround is dropped)' },
      ],
    },
    {
      title: 'IT',
      intro:
        'IT songs load the same way as S3M, with these differences. New note actions, filters and MIDI macros have no XM form and are left out.',
      entries: [
        { code: 'Cxx', text: 'IT stores the break row in hex; it is rewritten as decimal digits for Dxx' },
        { code: 'Hxy, Uxy', text: 'Vibrato depth is halved unless the song uses Old Effects, since IT swings half as far' },
        { code: 'Mxx, Nxy', text: 'Channel volume and channel volume slide → Mxx, Nxy' },
        { code: 'Pxy', text: 'Panning slide → Pxy with the nibbles swapped; fine slides are dropped' },
        { code: 'Vxx, Wxy', text: 'Global volume 0–128 and its slide, halved → Gxx, Hxy' },
        { code: 'Xxx', text: 'Panning → 8xx' },
        { code: 'Yxy, Zxx', text: 'Panbrello and MIDI macros: dropped' },
        { code: 'S5x – SAx', text: 'Panbrello waveform, fine pattern delay, NNA, surround, high offset: dropped' },
        { code: 'Volume column', text: 'Volume, slides, panning and vibrato map to the XM volume column; pitch slides and exact portamento speeds move to the effect column when it is free' },
      ],
    },
    {
      title: 'Saving',
      intro:
        'Saving as XM keeps everything the tracker plays, but S3M/IT-only details (sample panning off, global volume at start, fade after envelope) are dropped. ' +
        'Saving as MOD keeps effects 0–F and the first 31 samples.',
      entries: [],
    },
  ],
};

const WORKFLOWS: HelpSection = {
  id: 'workflow',
  title: 'Workflow',
  groups: [
    {
      title: 'Your first pattern',
      entries: [
        { code: '1', text: 'Pick an instrument in the Instruments list. To load a sound, open the Sample view and drop a WAV file on it, or generate a waveform with the tools there.' },
        { code: '2', text: 'Press Space (or Rec) to switch to edit mode; the cursor row turns red.' },
        { code: '3', text: 'Play notes with the computer keyboard or the piano. Each note goes into the row under the cursor with the current instrument, and the cursor moves down by Add rows.' },
        { code: '4', text: 'Move the cursor right into the volume and effect columns and type digits and letters. Help opened there jumps to the effect under the cursor.' },
        { code: '5', text: 'Press Enter to hear the song, Shift+Enter for just the pattern.' },
      ],
    },
    {
      title: 'Arranging',
      entries: [
        { code: 'Position', text: 'The order list plays patterns from top to bottom. Ins adds a position, Del removes it, - and + choose which pattern it plays. A pattern can appear many times.' },
        { code: 'Len', text: 'Rows in the current pattern, up to 256.' },
        { code: 'Chn', text: 'Number of channels; each plays one note at a time.' },
        { code: 'BPM, Spd', text: 'Starting tempo and speed of the song; Fxx changes them while it plays.' },
      ],
    },
    {
      title: 'Sounds',
      entries: [
        { code: 'Sample view', text: 'Load a sample or generate a sine, square, saw, triangle or noise wave, set the loop with the yellow markers, and use the tools to cut, normalize, reverse, resample and more.' },
        { code: 'Instr view', text: 'Volume and panning envelopes, fadeout, auto vibrato and which sample each key plays. Sustain points hold the envelope until key off.' },
        { code: 'Chip sounds', text: 'Short looped square, saw and noise waves make classic chip sounds. Combine them with arpeggio (0xy), vibrato (4xy), note cut (ECx) and volume slides.' },
      ],
    },
    {
      title: 'Saving and sharing',
      entries: [
        { code: 'Save', text: 'Download as XM or MOD, export WAV, FLAC or MP3, or go back to one of the autosaved versions.' },
        { code: 'Songs', text: 'Keeps songs in this browser so you can come back to them offline.' },
        { code: 'Share', text: 'Packs the song into a link; whoever opens it gets the song in their tracker.' },
      ],
    },
    {
      title: 'Demos and intros',
      intro: 'The replayer plays your songs in your own productions with the same engine as the tracker: one JavaScript file, nothing else to host.',
      entries: [
        { code: 'Replayer', text: 'The replayer page has the files to download, a demo player and the API, with a callback on every row to sync effects to the music.', link: { href: './replayer/', label: 'Open the replayer page' } },
        { code: 'Open in replayer', text: 'Save > Open in replayer opens the song you are working on in the replayer page, to hear it as your production will play it.' },
        { code: 'Clean up', text: 'Advanced Edit > Clean up removes unused patterns, instruments and samples, so the module loads faster and packs better.' },
      ],
    },
    {
      title: 'Jamming',
      intro: 'Several people edit one song at the same time. Edits go straight from browser to browser; nothing is uploaded.',
      entries: [
        { code: 'Start a jam', text: 'Jam > Start a jam makes this song the shared one. You host: everyone gets your song.' },
        { code: 'Invite link', text: 'New invite link makes a link for one person. They open it, press Join and send you their answer code; paste it and press Connect.' },
        { code: 'New tab', text: 'Opens the jam in another tab of this browser, to try it out or to edit two patterns side by side.' },
        { code: 'Cursors', text: 'A coloured frame in the pattern shows where each of the others is. Undo only takes back your own edits.' },
        { code: 'Leave', text: 'Everyone keeps the song as it was. When the host leaves, the jam ends for all.' },
      ],
    },
    {
      title: 'On a phone',
      entries: [
        { code: 'Menu', text: 'Opens the sheet with the Song, Instr and Scopes panels and every button of the toolbar.' },
        { code: 'Rec, Oct', text: 'The bar at the bottom switches edit mode and the octave of the piano.' },
        { code: 'Keys', text: 'Shows or hides the piano.' },
        { code: 'Pattern', text: 'Tap the pattern number above the editor to pick the pattern for this position, or to add an empty one or a copy with New and Clone.' },
        { code: 'Tap', text: 'Tap a field in the pattern to move the cursor there.' },
        { code: 'Rec', text: 'In edit mode a pad under the pattern shows the cursor cell in big fields. Tap Ins, Vol, Fx or Val and a keypad takes the place of the piano; it fills both digits, then moves down by Step. Fx, then two digits, enters a whole effect.' },
        { code: 'Step', text: 'How many rows the cursor moves after each entry (Add on the Song panel); the arrows move by one row or channel.' },
        { code: 'Off, Del, Undo', text: 'Key off in the note column, clear the field under the cursor, undo the last change.' },
      ],
    },
  ],
};

export const HELP_SECTIONS: HelpSection[] = [KEYS, EFFECT_SECTION, FORMATS, WORKFLOWS];

/** Help entry id for an effect and parameter in the effect column. */
export function effectHelpId(effect: number, param: number): string | null {
  if (effect === 0 && param === 0) return null;
  if (effect === 0x0e) return `fx-E${(param >> 4).toString(16).toUpperCase()}`;
  const id = `fx-${'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[effect] ?? ''}`;
  return findEntry(id) ? id : null;
}

/** Help entry id for a volume column byte. */
export function volumeHelpId(volume: number): string | null {
  if (volume < 0x10) return null;
  if (volume <= 0x50) return 'vol-set';
  const id = `vol-${'-+DUSVPLRM'[(volume >> 4) - 6] ?? ''}`;
  return findEntry(id) ? id : null;
}

export function findEntry(id: string): HelpEntry | null {
  for (const section of HELP_SECTIONS) {
    for (const group of section.groups) {
      const entry = group.entries.find((e) => e.id === id);
      if (entry) return entry;
    }
  }
  return null;
}

/** The section that holds an entry. */
export function sectionOf(id: string): HelpSection | null {
  return HELP_SECTIONS.find((s) => s.groups.some((g) => g.entries.some((e) => e.id === id))) ?? null;
}

export interface HelpTarget {
  /** Entry to show and mark, e.g. "fx-A". */
  id: string;
  /** What the cursor sits on, as shown in the pattern, e.g. "A0F". */
  shown: string;
}

/** The entry for the volume column or effect under the pattern cursor, if it holds one. */
export function cellHelpTarget(field: 'volume' | 'effect', cell: { volume: number; effect: number; param: number }): HelpTarget | null {
  const id = field === 'volume' ? volumeHelpId(cell.volume) : effectHelpId(cell.effect, cell.param);
  if (!id) return null;
  return { id, shown: field === 'volume' ? formatVolume(cell.volume) : formatEffect(cell.effect, cell.param) };
}

/** Whether an entry matches every word of a search. */
export function entryMatches(entry: HelpEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${entry.code} ${entry.name ?? ''} ${entry.text}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}
