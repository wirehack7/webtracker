// Text of the manual page (manual.html): longer chapters that walk through the
// tracker, followed there by the full reference from help-content.ts.
// Text in `backticks` is shown as a key or code, [text](href) as a link.
// Screenshots live in public/manual/ and come from scripts/manual-screenshots.mjs.

export type ManualBlock = string | { list: string[] } | { steps: string[] } | { tip: string };

/** A screenshot: `wide` ones span the page above the text, the rest sit beside it. */
export interface ManualFigure {
  /** File name in public/manual/, taken at twice the size given here. */
  file: string;
  width: number;
  height: number;
  alt: string;
  caption?: string;
  wide?: boolean;
}

export interface ManualChapter {
  id: string;
  title: string;
  blocks: ManualBlock[];
  figures?: ManualFigure[];
}

export const MANUAL_CHAPTERS: ManualChapter[] = [
  {
    id: 'start',
    title: 'Getting started',
    blocks: [
      'chiptrackr is a music tracker that runs in the browser. You write music in patterns: a grid of rows that play from top to bottom, with one column per channel. It loads and plays MOD, XM, S3M, IT, MTM, 669 and OKT modules and saves XM, the format of FastTracker 2, as its own.',
      'Nothing has to be installed and nothing is uploaded. Songs, settings and autosaves stay in your browser. After the first visit it works offline too. Setup > App and offline installs it as an app with its own window, which opens XM and MOD files; on iPhone and iPad use Share > Add to Home Screen. When a new version is ready, a bar offers to reload.',
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
    figures: [
      {
        file: 'desktop.png',
        width: 1280,
        height: 800,
        alt: 'The tracker playing the demo song: order list, song settings, transport buttons and instruments at the top, four scopes, and the pattern below.',
        caption: 'The demo song playing. Top row: Position, Song, Transport, Instruments and Samples; then the scopes and the pattern.',
        wide: true,
      },
      {
        file: 'help.png',
        width: 960,
        height: 768,
        alt: 'The Help dialog with tabs for keys, effects, formats and workflow and a search field.',
        caption: 'Help, searchable, with the keys, every effect and the formats.',
      },
    ],
    blocks: [
      'The top of the screen holds the song panels, the middle the editor, the bottom a status line.',
      {
        list: [
          '`Position`: the order list. Each line is a position in the song and names the pattern it plays.',
          '`Song`: title, pattern length (`Len`), number of channels (`Chn`), starting tempo (`BPM`) and speed (`Spd`), the octave for the keyboard and `Add`, the number of rows the cursor moves after each note.',
          '`Transport`: play the song or the pattern, stop, edit mode (`Rec`), and the buttons for files, songs, sharing, jams, Setup, Help, About and the Replayer page.',
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
    figures: [
      {
        file: 'pattern.png',
        width: 1024,
        height: 300,
        alt: 'A pattern in edit mode: the cursor row is red, a block over three channels is selected in blue.',
        caption: 'Edit mode: the cursor row turns red. The blue block is a selection, ready to copy, transpose or interpolate.',
        wide: true,
      },
    ],
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
    figures: [
      {
        file: 'sample.png',
        width: 1268,
        height: 320,
        alt: 'The sample editor showing a looped pulse wave, with rows of tool buttons and the Generate row above it.',
        caption: 'The sample editor with a pulse wave. Generate is the bottom row of buttons.',
        wide: true,
      },
    ],
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
    figures: [
      {
        file: 'instrument.png',
        width: 1268,
        height: 318,
        alt: 'The instrument editor with a volume envelope that swells and fades and a looping panning envelope.',
        caption: 'A pad: the volume envelope swells in and holds at the sustain point; the panning envelope loops between left and right.',
        wide: true,
      },
    ],
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
    figures: [
      {
        file: 'save.png',
        width: 504,
        height: 487,
        alt: 'The Save dialog: Save XM, Save MOD, Pattern XP and Track XT, audio export settings, replayer buttons and the autosaved versions.',
        caption: 'Save: modules, audio export, the replayer and the autosaves.',
      },
      {
        file: 'share.png',
        width: 576,
        height: 196,
        alt: 'The Share dialog with the quality setting and the link to copy.',
        caption: 'Share: the whole song in a link.',
      },
    ],
    blocks: [
      {
        list: [
          'The song is saved in the browser while you work. `Save` lists the latest autosaved versions, so a crash or a closed tab loses nothing.',
          '`Songs` keeps named songs in this browser, also offline. `Back up all (ZIP)` saves all of them in one ZIP file, and `Restore from ZIP` adds them back, here or in another browser or device.',
          '`Save XM` (`Ctrl+S`) downloads the song as an XM module, which every modern tracker and replayer reads. `Save MOD` converts it for ProTracker and Amiga players, keeping what MOD can hold.',
          '`Pattern XP` and `Track XT` save one pattern or one channel, to move parts between songs.',
          'Export audio renders the song as WAV (16, 24 or 32 bit), FLAC (lossless and smaller) or MP3 (128 to 320 kbit/s) at 44.1 to 96 kHz, and on request one extra file per channel (as a ZIP). Muted channels stay out of the mix. Rendering runs in the background, faster than real time.',
          'Export video renders the song with its pattern scrolling past the play row and a scope per channel, in your colours, as MP4 (H.264) or WebM (VP9): 1280 x 720 or 1920 x 1080 wide, 1080 x 1080 square or 1080 x 1920 upright for phones, at 30 or 60 frames per second. Chrome, Edge and Firefox render it in the background, faster than real time. Other browsers record it in real time while it plays, so keep the tab in front.',
          '`Share` packs the whole song into a link. Exact keeps every sample as it is; Small (8-bit samples, cut after the loop) and Smallest (also half the sample rate) shrink the samples so longer songs still fit in a link. Whoever opens the link gets the song in their tracker; no server stores it.',
        ],
      },
      {
        tip: 'Songs, autosaves and settings belong to this browser on this device. Save the song as XM, back up the songs (Songs) or everything (Setup) as a ZIP, or send everything to another browser from Setup, to keep them safe or to move them.',
      },
    ],
  },
  {
    id: 'jam',
    title: 'Jamming with others',
    figures: [
      {
        file: 'jam.png',
        width: 462,
        height: 171,
        alt: 'The Jam dialog with a name field and the Start a jam button.',
        caption: 'Start a jam with your name.',
      },
    ],
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
    figures: [
      {
        file: 'phone.png',
        width: 390,
        height: 844,
        alt: 'The tracker on a phone: the pattern, the on-screen piano and the bar with Play, Rec, octave and Menu.',
        caption: 'Pattern and piano.',
      },
      {
        file: 'phone-entry.png',
        width: 390,
        height: 844,
        alt: 'Edit mode on a phone: the pad with big fields for note, instrument, volume and effect under the piano.',
        caption: 'Edit mode with the entry pad.',
      },
      {
        file: 'phone-menu.png',
        width: 390,
        height: 844,
        alt: 'The phone menu slid up with the song, instrument and scope tabs, the toolbar buttons and the song settings.',
        caption: 'Menu with all panels.',
      },
    ],
    blocks: [
      'On a phone the editor and an on-screen piano fill the screen. The bar at the bottom has Play/Stop, `Rec`, the octave and `Menu`, which slides up all the panels and toolbar buttons.',
      'In edit mode a pad under the pattern shows the cursor cell in big fields. Tap `Ins`, `Vol`, `Fx` or `Val` and a hex keypad takes the place of the piano. `Step` is how far the cursor moves after each entry; `Off`, `Del` and `Undo` write a key off, clear the field and undo.',
      'Tap a field in the pattern to move the cursor there. Drag on the piano, its octave strip, or swipe with two fingers to reach other octaves.',
      'Above the editor, the instrument button opens a list of all instruments, and the arrows next to it step through them. Tap the pattern number to pick which pattern plays at the current position: the list shows each pattern with its length and the positions that play it. `New` and `Clone` put an empty pattern or a copy of this one at the position, the arrows step through the positions, and `Ins pos` and `Del pos` add or remove one.',
    ],
  },
  {
    id: 'setup',
    title: 'Setup, sound and MIDI',
    figures: [
      {
        file: 'setup.png',
        width: 600,
        height: 578,
        alt: 'The Setup dialog with colours, interface size, resampling, stereo, amplification and further options.',
        caption: 'Setup. Settings stay in this browser.',
      },
    ],
    blocks: [
      {
        list: [
          'Language: English, German or Finnish for the interface, Help and this manual. Auto follows the language of the browser. Tracker terms such as Pattern, Sample and the effect names stay in English.',
          'Colours: several schemes and a colour editor; colours can be exported and imported as a file.',
          'Interface size: Small, Compact, Medium or Large for panels, text and the pattern. Auto is Compact with a mouse and Medium on tablets. Sizes snap to whole screen pixels so the font stays sharp, which on a plain (non-HiDPI) screen leaves Small and Compact alike, and Medium and Large alike; phones keep their own size.',
          'Resampling: how samples are played at other pitches. Auto plays MOD songs like an Amiga 500 (with its filter) and the rest with linear interpolation; Cubic and Sinc are smoother still, None gives the crunchy sound of old PC trackers.',
          'Stereo width, amplification and volume ramps (soft starts and ends of notes against clicks).',
          'Row highlights, prospective view (shows the neighbouring patterns dimmed), cursor wrapping and what the Space key does.',
          'MIDI input: play and record with a MIDI keyboard (in browsers that support Web MIDI), optionally writing the velocity into the volume column.',
          'Backup and transfer: `Back up everything` saves all songs and the settings in one ZIP file, and `Restore backup` adds its songs back and offers its settings. `Send to another browser` copies both straight to another browser, on this or another device: open the transfer link there and paste the answer code it shows back here. Nothing is uploaded.',
        ],
      },
    ],
  },
  {
    id: 'demo',
    title: 'Music for demos and intros',
    figures: [
      {
        file: 'replayer.png',
        width: 720,
        height: 295,
        alt: 'The replayer page playing the demo song, with a channel display and the play position.',
        caption: 'The replayer page playing the song from the tracker.',
      },
    ],
    blocks: [
      'The replayer plays your songs in your own productions with the same engine as the tracker. It is a single JavaScript module with nothing else to host: a full version for every format the tracker loads, and a lite version for XM and MOD only.',
      'The [replayer page](./replayer/) has the files, a demo and the API: it loads a song, plays and stops it, and calls you back on every row with the current order, pattern, row, speed and tempo, so effects in your demo can sync to the music. Unused effect values such as `E8x` are often used as sync markers. The `Replayer` button in the toolbar (in the Menu on a phone) opens the page.',
      {
        steps: [
          'Press `Save` and then `Open in replayer`. The replayer page opens in a new tab with your song, to hear it as your production will play it.',
          'Press `Save XM` (or `Save MOD` for a ProTracker song) to get the module file for your production.',
          'Download `webtracker-replayer.js` (or the smaller lite version for XM and MOD) from the replayer page and put it next to the module.',
          'Load the song with `createReplayer`, start it with `play()` after a click, and use `onRow` to sync your effects.',
        ],
      },
      {
        tip: 'Open Stats before releasing a song: it shows what takes the most room, and Optimize makes the module smaller, so it loads faster and packs better.',
      },
    ],
  },
];
