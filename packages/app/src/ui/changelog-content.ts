// What's new: the changes people notice, newest release first. To add one, put
// a new release at the top with today's date as its id (add a letter for a
// second one on the same day: '2026-10-27b'), write each change in a sentence
// for players rather than for developers, wrap it in msg() and add it to
// every language pack. Returning visitors see the dialog once per new id.

import { msg } from '../i18n/i18n.ts';

export interface Release {
  /** The release date, YYYY-MM-DD; ids sort in release order. */
  id: string;
  items: string[];
}

export const CHANGELOG: Release[] = [
  {
    id: '2026-10-26b',
    items: [
      msg('The sample library has chip waves, PWM loops, drums and effects, all made by the tracker and free to use. Open it with Library in the sample or instrument editor, or from the instrument picker on phones.'),
    ],
  },
  {
    id: '2026-10-26',
    items: [
      msg('The tracker speaks German and Finnish too. Pick a language in Setup > Language, or let it follow your browser.'),
      msg('Back up all your songs and settings in one ZIP file, and restore them later: Setup > Backup and transfer.'),
      msg('Send to another browser moves your songs and settings from one device to another, phone to laptop for example, with a link and an answer code.'),
      msg('The Songs dialog backs up your song library as a ZIP file and adds songs from one.'),
      msg('Dialogs fit phone screens: full width, bigger buttons, and Close always in reach.'),
      msg('Help on phones: Close sits beside the title and every topic tab is in view.'),
      msg('iPhone and iPad: tracker files can be picked when loading again, and the sound plays with the silent switch on.'),
      msg('Firefox is checked with every update, together with Chrome and Safari.'),
      msg('The manual has screenshots and uses the full width of large screens.'),
      msg('This What\'s new window shows what changed since your last visit. Help opens it any time.'),
    ],
  },
  {
    id: '2026-10-25',
    items: [
      msg('Export your song as WAV, FLAC or MP3 from the Save dialog.'),
      msg('Jam: make music together live with a friend through an invite link.'),
      msg('The replayer plays your song in demos and intros. Save > Open in replayer tries it right away.'),
      msg('A new demo song, Pixel Sunrise, waits in the Songs library.'),
      msg('On phones: an instrument picker, a pattern picker and a keypad for entering notes and effects in Rec mode.'),
      msg('Setup > Interface size makes everything smaller or larger.'),
      msg('XM and MOD songs play closer to the original trackers.'),
      msg('The Help has more topics, and the About window has a little intro.'),
    ],
  },
];
