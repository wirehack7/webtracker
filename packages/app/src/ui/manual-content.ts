// Text of the manual page (manual.html): longer chapters that walk through the
// tracker, followed there by the full reference from help-content.ts.
// Text in `backticks` is shown as a key or code.

export type ManualBlock = string | { list: string[] } | { steps: string[] } | { tip: string };

export interface ManualChapter {
  id: string;
  title: string;
  blocks: ManualBlock[];
}

export const MANUAL_CHAPTERS: ManualChapter[] = [
  {
    id: 'start',
    title: 'Getting started',
    blocks: [
      'chiptrackr is a music tracker that runs in the browser. You write music in patterns: a grid of rows that play from top to bottom, with one column per channel. It loads and plays MOD, XM, S3M, IT, MTM, 669 and OKT modules and saves XM, the format of FastTracker 2, as its own.',
      'Nothing has to be installed and nothing is uploaded. Songs, settings and autosaves stay in your browser. The browser can install the site as an app (the install button in the address bar, or "Add to home screen" on a phone); after the first visit it also works offline.',
      'Browsers only allow sound after you interact with the page, so audio starts with the first key you press or the first tap on the piano.',
      {
        steps: [
          'Open Songs and pick the demo song "Pixel Sunrise", then press `Enter` to hear it.',
          'Press `Space` to stop. Click into the pattern and move around with the arrow keys to see how the notes and effects are written.',
          'Press `New` when you want to start with an empty song.',
        ],
      },
    ],
  },
  {
    id: 'screen',
    title: 'The screen',
    blocks: [
      'The top of the screen holds the song panels, the middle the editor, the bottom a status line.',
      {
        list: [
          '`Position`: the order list. Each line is a position in the song and names the pattern it plays.',
          '`Song`: title, pattern length (`Len`), number of channels (`Chn`), starting tempo (`BPM`) and speed (`Spd`), the octave for the keyboard and `Add`, the number of rows the cursor moves after each note.',
          '`Transport`: play the song or the pattern, stop, edit mode (`Rec`), and the buttons for files, songs, sharing, jams, Setup and Help.',
          '`Instruments` and `Samples`: the instrument you play with and its samples.',
          'Scopes show what every channel plays. Click a scope to mute its channel, right-click to solo it.',
          '`Pattern`, `Sample` and `Instr` switch the editor between the pattern, the sample editor and the instrument editor.',
        ],
      },
      {
        tip: 'Help (`Help` button) is the quick reference; with the pattern cursor on an effect it opens at that effect.',
      },
    ],
  },
  {
    id: 'basics',
    title: 'Tracker basics',
    blocks: [
      'A pattern has 1 to 256 rows; every row has a cell per channel. A channel plays one note at a time, so chords need several channels or the arpeggio effect.',
      'A cell has five fields:',
      {
        list: [
          'Note, such as `C-4` or `F#3`, or `===` for key off, which releases the note so its envelope can fade out.',
          'Instrument, two hex digits (`01` to `80`). An empty field keeps the instrument the channel played last.',
          'Volume column, a volume `00` to `40` or a short command such as a slide or panning.',
          'Effect, one character, and its parameter, two hex digits: `A0F` is a volume slide down at speed F.',
        ],
      },
      'Numbers are hexadecimal: after 9 come A to F, so `40` is 64 and `FF` is 255.',
      'Time runs in ticks. A row lasts `Spd` ticks, and a tick lasts 2.5 / BPM seconds. At the usual speed 6 and 125 BPM a row lasts 120 ms, and four rows make a beat at 125 beats per minute. Lower speeds play faster; `F03` halves the row length from speed 6.',
    ],
  },
  {
    id: 'pattern',
    title: 'Writing a pattern',
    blocks: [
      {
        steps: [
          'Pick an instrument in the Instruments list.',
          'Press `Space` or `Rec`. The cursor row turns red: you are in edit mode.',
          'Play notes on the computer keyboard. The bottom two rows (`Z S X D C` …) play the lower octave, the two rows above (`Q 2 W 3 E` …) the octave above it. The keys go by position, so this works with any keyboard layout. `F1` to `F7` choose the octave.',
          'Every note goes into the cell under the cursor, and the cursor moves down by `Add` rows. Set `Add` to 4 to write one note per beat.',
          'Press `1` (or the key left of `1`) for a key off.',
          'Move right into the volume and effect fields and type hex digits and effect letters.',
          'Press `Enter` to play the song, `Shift+Enter` to play just this pattern, `Alt+Enter` to play only the cursor row.',
        ],
      },
      'To work on many cells at once, select a block with `Shift+Arrows` or by dragging. Copy, cut and paste work as usual (`Ctrl+C X V`); `Ctrl+Shift+V` pastes only into empty fields, which mixes two parts together. `Alt+Up/Down` transposes the selection, `Ctrl+I` fills in a smooth ramp between the volumes or effect values at the ends of the selection.',
      '`Ctrl+E` opens Advanced Edit: transpose one instrument only, swap one instrument for another, scale the volume over a range (for fades), and clean up the song before you release it (unused patterns, instruments and samples, sample data after the loop end).',
      {
        tip: 'Everything can be undone with `Ctrl+Z`, also after a jam or a clean-up.',
      },
    ],
  },
  {
    id: 'sounds',
    title: 'Making chip sounds',
    blocks: [
      'Classic chip sounds come from very short, looped waveforms. The Sample view can generate them: open `Sample` and use Generate to make a sine, square, saw, triangle or noise wave in the current slot.',
      {
        list: [
          'Square waves are the typical lead. Two samples with different pulse widths, or a volume envelope on one of them, give the hollow-to-bright change of a C64 or NES lead.',
          'Triangle and sine are soft basses. Play them an octave or two lower.',
          'Noise with a short volume envelope or a note cut (`EC1` to `EC3`) makes hi-hats and snares; a sine with a fast pitch drop (`2xx`) makes a kick.',
          'Arpeggio (`037`, `047`) plays chords on one channel, the sound of many C64 and Amiga songs. Vibrato (`4xy`) and portamento (`3xx`) make leads sing.',
        ],
      },
      'You can also drop a recording (WAV, AIFF, FLAC, MP3, OGG and more) on the Sample view. The tools there cut, fade in and out, normalize, reverse and resample; drag across the waveform to select and drag the yellow markers to move the loop.',
    ],
  },
  {
    id: 'instruments',
    title: 'Instruments and envelopes',
    blocks: [
      'An instrument holds one or more samples and says how they play. The `Instr` view shows its settings.',
      {
        list: [
          'Volume envelope: how loud the note is over time. Click to add a point, drag to move it, right-click to delete it. A sustain point holds the envelope until key off; a loop repeats part of it, for tremolo-like movement.',
          'Panning envelope: moves the note between left and right over time.',
          'Fadeout: after key off the note fades out at this speed. With fadeout 0 a released note keeps sounding.',
          'Auto vibrato: a vibrato that starts by itself, with a sweep to bring it in slowly. It gives held chip leads life without effects in the pattern.',
          'Key map: which sample plays for which note, so one instrument can hold a whole drum kit or a multi-sampled sound.',
        ],
      },
      'The presets in the envelope editor are a good start: pick one, then shape it.',
    ],
  },
  {
    id: 'arranging',
    title: 'Arranging a song',
    blocks: [
      'The order list plays patterns from top to bottom. `Ins` adds a position, `Del` removes it, `-` and `+` change which pattern it plays. A pattern can be used many times, so write a bass line once and play it under different melodies.',
      'At the end the song starts over. Put `Bxx` in the last pattern to loop back to position xx instead, for example past the intro. `Dxx` ends a pattern early, `Fxx` changes speed or tempo on the way.',
      'With Song tabs on (Setup), New, Load and shared links open a song in a new tab, and `Alt+PgUp/PgDn` switches between them.',
    ],
  },
  {
    id: 'saving',
    title: 'Saving, exporting and sharing',
    blocks: [
      {
        list: [
          'The song is saved in the browser while you work. `Save` lists the latest autosaved versions, so a crash or a closed tab loses nothing.',
          '`Songs` keeps named songs in this browser, also offline.',
          '`Save XM` (`Ctrl+S`) downloads the song as an XM module, which every modern tracker and replayer reads. `Save MOD` converts it for ProTracker and Amiga players, keeping what MOD can hold.',
          '`Pattern XP` and `Track XT` save one pattern or one channel, to move parts between songs.',
          'Export audio renders the song as WAV (16, 24 or 32 bit), FLAC (lossless and smaller) or MP3 (128 to 320 kbit/s) at 44.1 to 96 kHz, and on request one extra file per channel (as a ZIP). Muted channels stay out of the mix. Rendering runs in the background, faster than real time.',
          '`Share` packs the whole song into a link. Exact keeps every sample as it is; Small (8-bit samples, cut after the loop) and Smallest (also half the sample rate) shrink the samples so longer songs still fit in a link. Whoever opens the link gets the song in their tracker; no server stores it.',
        ],
      },
      {
        tip: 'Songs, autosaves and settings belong to this browser on this device. Save the song as XM to keep it safe or to move it to another device.',
      },
    ],
  },
  {
    id: 'jam',
    title: 'Jamming with others',
    blocks: [
      'In a jam several people edit one song at the same time, each with their own cursor. Edits go straight from browser to browser; the song is never uploaded.',
      {
        steps: [
          'Open `Jam`, type your name and press `Start a jam`. You are the host, and everyone gets your song.',
          'Press `New invite link` and send the link to one person.',
          'They open it, press `Join` and send you the answer code it shows.',
          'Paste the answer code and press `Connect`. Repeat with a new invite link for each person.',
        ],
      },
      'Some strict networks (certain mobile carriers and company firewalls) block direct connections between browsers; then the connection does not come up. `Open in a new tab` jams between two tabs of the same browser, which always works.',
    ],
  },
  {
    id: 'phone',
    title: 'Phones and tablets',
    blocks: [
      'On a phone the editor and an on-screen piano fill the screen. The bar at the bottom has Play/Stop, `Rec`, the octave and `Menu`, which slides up all the panels and toolbar buttons.',
      'In edit mode a pad under the pattern shows the cursor cell in big fields. Tap `Ins`, `Vol`, `Fx` or `Val` and a hex keypad takes the place of the piano. `Step` is how far the cursor moves after each entry; `Off`, `Del` and `Undo` write a key off, clear the field and undo.',
      'Tap a field in the pattern to move the cursor there. Drag on the piano, its octave strip, or swipe with two fingers to reach other octaves.',
    ],
  },
  {
    id: 'setup',
    title: 'Setup, sound and MIDI',
    blocks: [
      {
        list: [
          'Colours: several schemes and a colour editor; colours can be exported and imported as a file.',
          'Resampling: how samples are played at other pitches. Auto plays MOD songs like an Amiga 500 (with its filter) and the rest with linear interpolation; Cubic and Sinc are smoother still, None gives the crunchy sound of old PC trackers.',
          'Stereo width, amplification and volume ramps (soft starts and ends of notes against clicks).',
          'Row highlights, prospective view (shows the neighbouring patterns dimmed), cursor wrapping and what the Space key does.',
          'MIDI input: play and record with a MIDI keyboard (in browsers that support Web MIDI), optionally writing the velocity into the volume column.',
        ],
      },
    ],
  },
  {
    id: 'demo',
    title: 'Music for demos and intros',
    blocks: [
      'The replayer plays your songs in your own productions with the same engine as the tracker. It is a single JavaScript module with nothing else to host: a full version for every format the tracker loads, and a lite version for XM and MOD only.',
      'The replayer page has the files, a demo and the API: it loads a song, plays and stops it, and calls you back on every row with the current order, pattern, row, speed and tempo, so effects in your demo can sync to the music. Unused effect values such as `E8x` are often used as sync markers.',
      {
        tip: 'Run Advanced Edit > Clean up before releasing a song: smaller modules load faster and pack better.',
      },
    ],
  },
];
