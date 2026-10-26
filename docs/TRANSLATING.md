# Translating chiptrackr

The tracker, its Help and the manual page can be shown in more than one
language. English is the source and the default; German and Finnish are the
translations so far. This page says how the language packs work and how to add one.

## How it works

Every text in the app is written in English, in the code and in the HTML
pages. That English text is also the key a language pack looks it up by, the
way gettext does it. A language pack is one file that maps English texts to
their translation:

```ts
// packages/app/src/i18n/de.ts
export default {
  'Play song (Enter)': 'Song abspielen (Enter)',
  'Saved {file} ({bytes} bytes).': '{file} gespeichert ({bytes} Bytes).',
  …
} satisfies Record<string, string>;
```

- `src/i18n/i18n.ts` holds the list of languages (`LANGUAGES`) and the
  functions that use them. Each pack is its own file and is loaded only when
  it is chosen, so English users download nothing extra.
- Setup > Language picks a language. Auto, the default, takes the first of the
  browser's languages that has a pack, else English. A change applies after a
  reload, which Setup offers.
- The texts written in `index.html` and `manual.html` are translated as the
  page starts: text between tags and the `title`, `aria-label`, `placeholder`
  and `label` attributes. Elements marked `translate="no"` keep their text.
- Texts made by the code go through `t()`: `t('Saved {file}.', { file })`.
  Texts defined in one place and shown in another are marked with `msg()`
  where they are defined and passed through `t()` where they are shown.
- Help (`src/ui/help-content.ts`) and the manual (`src/ui/manual-content.ts`)
  are translated entry by entry. Help searches the English words as well, so
  a search for an English term still finds the entry.
- Undo and Redo name the edit in the status line; those names are listed in
  `src/i18n/edit-names.ts`.
- A text a pack does not have is shown in English.

Not translated: error messages that come from inside the engine and file
loaders, the replayer page and the README.

## Tracker terms stay in English

Trackers have always used English words for their parts, and musicians look
them up by those names. In every language, keep these as they are:

Pattern, Sample, Instrument, Envelope, Loop, Panning, Volume (the column and
the effects), Track, Position, Order, Speed, BPM, Tick, Key off, Sustain,
Fadeout, Finetune, the effect names (Arpeggio, Portamento, Vibrato, Tremolo,
Retrigger, Note cut, Note delay, …), Scopes, Jam and Replayer.

Short labels on buttons and fields that come from FastTracker 2 stay too:
Play Song, Play Pat, Stop, Rec, Ins, Del, Add, Oct, Chn, Len, Spd, the sample
editor tools (Cut, Copy, Paste, Crop, Norm, …) and the envelope buttons. The
German pack keeps them as identical entries, which also shows that they were
left in English on purpose.

Everyday words are translated: Save, Load, Help, Close, the dialog texts,
tooltips and messages. Write the way the scene talks to each other (the German
pack says du).

## Adding a language

1. Copy `packages/app/src/i18n/de.ts` to a file named after the language's
   [BCP 47 code](https://www.iana.org/assignments/language-subtag-registry),
   for example `fr.ts`, and translate the values. Keep the keys exactly as they
   are.
2. Add the language to `LANGUAGES` in `packages/app/src/i18n/i18n.ts`, with
   its own name for itself:

   ```ts
   fr: { name: 'Français', load: () => import('./fr.ts') },
   ```

3. Run the tests: `pnpm test packages/app/src/i18n`.

The tests check every pack against the app. They fail, with the list of texts
concerned, when

- a text of the app has no translation in the pack,
- the pack translates a text the app no longer has,
- a translation lost or renamed a `{placeholder}` or a link target, or has a
  different number of `` `key` `` marks than the English text. The text inside
  the backticks may change when it names a translated button (`` `Save` ``
  becomes `` `Speichern` `` in German).

Check the result in the browser too, at desktop and phone size: `pnpm dev`,
then choose the language in Setup. Longer words can crowd the buttons; the
phone layout is the tightest. `pnpm build && pnpm smoke` checks the German
and Finnish packs at desktop and phone size; a new language can get the same
check there.

## Changing English texts

A changed English text is a new key. When you change or add one, update
every pack in the same pull request; the tests list what is missing and what
is no longer used. Keys must be plain string literals in `t()`, `tNodes()` or
`msg()` (no template literals or concatenation), so the tests can find them.
