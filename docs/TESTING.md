# Testing

This page says how chiptrackr is tested, what those tests cover and, just as
plainly, what they do not. Every number here comes from a check in this
repository that you can run yourself, and all of them except the last section
run in CI on every pull request.

Numbers are from 2026-10-25. The CI job summaries always show the current ones:
[CI](../.github/workflows/ci.yml) (unit tests, coverage, browser smoke test) and
[Replayer vs libopenmpt](../.github/workflows/reference.yml).

## At a glance

| Check | What it proves | Result |
| --- | --- | --- |
| Unit tests (Vitest) | Loaders, writers, replayer rules, editing, sharing, Jam sync, encoders | 248 tests in 40 files, all passing |
| Code coverage (V8) | Which source lines those tests execute | 55 % of lines overall; formats 93 %, engine 79 %, app 20 % |
| Replayer vs libopenmpt | XM and MOD playback against an independent player on the OpenMPT test suite | XM 78 of 84 match; MOD 22 of 22 match on the ProTracker side-by-side check |
| Browser smoke test (Playwright) | The built site loads, plays and stops at six screen sizes, with no errors and no sideways scrolling; typing notes changes the saved XM; WAV and MP3 export produce files; the replayer page plays | 8 of 8 checks passing in headless Chromium and in headless Firefox |
| iPhone / iPad smoke test (Playwright WebKit) | Picking, loading and saving files, tap to play, IndexedDB and the replayer page on emulated iPhone 15, iPhone SE and iPad Mini | 4 of 4 checks passing in headless WebKit |
| Type check | TypeScript in strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) across all packages | Clean |

## Running it

```sh
pnpm install
pnpm test              # all unit tests
pnpm test:coverage     # the same with coverage; HTML report in coverage/index.html
pnpm typecheck

pnpm build
pnpm smoke [shots/]    # browser smoke test against packages/app/dist, optional screenshots
pnpm smoke [shots/] --firefox  # the same in Firefox
pnpm smoke:ios [shots/]  # the same for iPhone and iPad in WebKit
pnpm screenshots:manual  # retake the screenshots of the manual page (packages/app/public/manual)
```

The smoke tests need Playwright's Chromium, Firefox and WebKit
(`pnpm exec playwright install chromium firefox webkit`); `pnpm smoke:ios --chromium`
runs the iOS checks in Chromium with an iPhone user agent where WebKit is missing.

The replayer comparison needs an `ffmpeg` built with libopenmpt (the Ubuntu and
Debian packages are) and the OpenMPT test modules, which are not checked in:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/libxmp/libxmp
git -C libxmp sparse-checkout set test-dev/openmpt
pnpm --filter @webtracker/formats reference-check libxmp/test-dev/openmpt/xm xm-report.md
pnpm --filter @webtracker/formats reference-check libxmp/test-dev/openmpt/mod mod-report.md
```

A robustness run over any folder of real MOD and XM files (each must load or be
rejected cleanly, then render 10 seconds without NaN):

```sh
MODULE_DIR=~/mods pnpm test
```

## Code coverage

Measured with `pnpm test:coverage` (V8 coverage over `packages/*/src`, test
helpers excluded):

| Package | Lines | Statements | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| formats | 93.4 % | 89.4 % | 73.3 % | 95.5 % |
| engine | 78.6 % | 76.2 % | 60.7 % | 92.8 % |
| replayer | 35.4 % | 32.0 % | 27.5 % | 11.4 % |
| app | 19.9 % | 20.2 % | 17.5 % | 21.5 % |
| **all** | **55.0 %** | **53.7 %** | **47.1 %** | **46.8 %** |

How to read this:

- **formats** (loaders, writers, encoders) and **engine** (song model, replayer,
  mixer, editing) are where the logic lives, and they are well covered. The
  engine's `player.ts` is at 71 % of lines. The biggest gaps are the simpler
  S3M/IT playback path, and effect branches that only the libopenmpt
  comparison below exercises (for example Lxx set envelope position, several
  ProTracker E commands, tremolo and multi-retrig volumes); that run is not
  counted in these numbers.
- **app** is low because most of it is DOM code: `main.ts`, the pattern, sample
  and instrument editors, the piano and the dialogs. Unit tests cover the logic
  that sits behind the UI (note entry, undo, song editing, share links, Jam
  sync, settings, help content), and the browser smoke test exercises the UI as
  a whole, but that run is not counted in these numbers. Interactions such as
  drawing in the sample editor or dragging envelope points are not tested
  automatically.
- **replayer**: the core logic is at 93 %; the AudioWorklet wrapper and the
  public API around it run only in a browser, where the smoke test plays the
  replayer page.

## Replayer accuracy against FastTracker 2 and ProTracker

The OpenMPT project publishes test modules for player bugs it found over the
years. Most of them play the tested feature on the left and a plain version of
the same sound on the right, so a correct player gives matching sides (or
silence for the "should stay quiet" tests). libxmp mirrors them in
`test-dev/openmpt`.

`packages/formats/scripts/reference-check.ts` plays every module with our
replayer and with libopenmpt (through ffmpeg), and scores the match as the mean
cosine similarity of per-frame log spectra: 1 is the same sound, and a module
passes at 0.9. XM files are labelled as "FastTracker v2.00" first so libopenmpt
uses its FT2 rules. As a control, each render is also scored against the
previous module's reference: unrelated sounds average about 0.5, and 4 of 83
such pairs in the XM set reach 0.9 (0 of 21 for MOD), so the metric is not
blind, but a pass is evidence rather than proof.

| Set | vs libopenmpt | Left vs right (our own output) | Either |
| --- | ---: | ---: | ---: |
| XM, 84 modules | 78 | 59 | 82 |
| MOD, 22 modules | 17 | 22 | 22 |

The CI job fails if XM drops below 76 matches against libopenmpt or MOD below 22
on the left-vs-right check.

Known differences, all on purpose or under review:

- **XM**: `SampleChange.xm` and `PanMemory`-style cases follow the code of
  [ft2-clone](https://github.com/8bitbubsy/ft2-clone) (an exact port of FT2's
  replayer) where it disagrees with libopenmpt. `FineVol-LinkMem.xm`,
  `Porta-LinkMem.xm` and `Porta-LinkMem_old.xm` score low against libopenmpt
  but give identical left and right sides. `PatternDelays.xm` and
  `FT2PanLaw.xm` are just under the mark on both checks and are open.
- **MOD**: the MOD replayer is a port of the ProTracker 2 replay routine and
  Paula, checked against [pt2-clone](https://github.com/8bitbubsy/pt2-clone).
  libopenmpt is not ProTracker-exact, so the left-vs-right check (ProTracker's
  side against ours) is the meaningful one for MOD; it passes 22 of 22. The four
  modules that score under 0.9 against libopenmpt are sample-swap, pattern jump
  and portamento-target quirks where the two players differ.

On top of this, `ft2.test.ts` (10 tests) and `pt2.test.ts` (7 tests) pin down
individual FT2 and ProTracker quirks with exact numbers (arpeggio order, Rxy
tick counting, glissando, sample swap at loop end, 9xx offset doubling, EFx
invert loop, E8x Karplus-Strong and more), so they are checked in every CI run
without network access.

S3M and IT files are loaded into the XM-shaped song model and play with simpler
rules. Their loaders are unit tested, including the IT 2.14/2.15 sample
decompressor, but their playback is **not** compared with Scream Tracker or
Impulse Tracker.

## Browser smoke test

`scripts/smoke.mjs` serves the production build and opens it in headless
Chromium at 1440×900, 1280×720, 820×1180 (tablet), 390×844 (phone),
844×390 (phone landscape) and 320×568 (small phone). At each size it checks
that:

- the page loads with no JavaScript errors and no console errors,
- nothing makes the page scroll sideways,
- Play starts the AudioWorklet and keeps playing, and Stop stops it,
- the Help dialog opens.

It also opens the replayer page and plays its demo. Screenshots of every size
are kept as a CI artifact. It is a smoke test: it shows the app starts and its
main loop works at each size, not that every control does the right thing.

### iPhone and iPad

`scripts/smoke-ios.mjs` opens the build in Playwright's WebKit, the engine of
every iOS browser, emulating an iPhone 15, an iPhone SE and an iPad Mini (touch,
screen size, user agent). It checks that:

- no file input carries an `accept` filter, since iOS turns that into file types
  it has none of for tracker formats and greys the files out in the picker,
- Load opens the file picker and a picked `.mod` opens, and any other file
  explains itself in a dialog,
- the sample importer takes a picked file,
- a tap on Play starts the AudioWorklet and the song,
- Save XM starts a download,
- the song library is in IndexedDB,
- the replayer page loads a picked module and plays it.

Playwright's WebKit is a Linux build, not iOS. It cannot show the real iOS file
picker, the ring/silent switch or the iOS audio session, so those stay checked by
hand on a real device: the files must be selectable in the picker, sound must play
with the silent switch on (Safari 17 and later), and Save must offer the share
sheet or Save to Files.

## Feature coverage

✅ automated check in CI · ◐ partly, see notes · ✋ checked by hand during development only · ✗ not verified

| Feature | Unit tests | Reference / browser | Notes |
| --- | :---: | :---: | --- |
| XM playback (FT2 rules) | ✅ | ✅ libopenmpt | 78 of 84 OpenMPT tests, plus `xm.test.ts`, `ft2.test.ts` |
| MOD playback (ProTracker 2 rules, Paula, A500/LED filter) | ✅ | ✅ libopenmpt | 22 of 22 side-by-side, plus `mod.test.ts`, `pt2.test.ts`, `render.test.ts` |
| S3M / IT playback | ◐ | ✗ | Loaders and pitch tested; playback not compared with ST3/IT |
| Effects | ◐ | ✅ libopenmpt | Covered through the OpenMPT suite and the FT2/PT2 tests; there is no one-test-per-effect list |
| Envelopes, fadeout, auto-vibrato | ✅ | ✅ libopenmpt | `xm.test.ts`, `ft2.test.ts`, `preview.test.ts`, OpenMPT envelope tests |
| Resamplers and stereo separation | ✅ | – | `render.test.ts` (none, linear, cubic, sinc, Amiga) |
| Load MOD, XM, S3M, IT, MTM, 669, OKT | ✅ | – | One test file per format with built test modules |
| Containers: ZIP, gzip, MMCMP, PowerPacker, UMX | ✅ | – | `unpack.test.ts`, inflate checked against zlib |
| Save XM, MOD, XI, 8SVX, XP, XT | ✅ | – | Round trips: save, load back, compare |
| Sample import (WAV, AIFF, 8SVX, XI, PAT, raw) | ✅ | – | `sample-import.test.ts`; FLAC/MP3/OGG import is left to the browser and not tested |
| Export WAV | ✅ | – | 16-bit, 24-bit and float read back |
| Export FLAC | ✅ | – | Own encoder, bit-exact round trip of 16 and 24 bit |
| Export MP3 | ◐ | – | Frame headers, ID3 and rate cap checked; audio quality judged by ear only |
| Pattern editing, blocks, transpose, interpolate | ✅ | – | `edit.test.ts`, `entry.test.ts` |
| Undo / redo, song settings | ✅ | – | `song-editor.test.ts` |
| Sample editor operations | ✅ | ✗ | The operations are tested (`sample-edit.test.ts`); the editor's mouse and touch handling is not |
| Instrument editor, envelope drawing | ◐ | ✗ | Presets tested; the editor UI is not |
| Song cleanup | ✅ | – | `cleanup.test.ts` |
| Keyboard layout and octave keys | ✅ | – | `keyboard.test.ts` |
| Touch keypad entry | ✅ | ◐ | `entry-pad.test.ts`; phone layout in the smoke test |
| Responsive layout | – | ✅ | Six sizes in the smoke test, Chromium only |
| Autosave and song library (IndexedDB) | ◐ | ✋ | MOD autosave round trip tested; the IndexedDB layer itself is not |
| Share links | ✅ | – | `share.test.ts` |
| Jam (live editing together) | ✅ | ✗ | Sync logic tested with simulated peers, including conflicting edits and message reordering; the WebRTC connection is not |
| Replayer for demos and intros | ◐ | ✅ | Core tested; the page plays its demo in the smoke test |
| MIDI input | ◐ | ✗ | Note and velocity mapping tested; no real MIDI device |
| Offline use (service worker) | – | ✋ | Not tested automatically; the smoke test blocks the service worker |
| Help and manual | ✅ | ◐ | Every effect has a help entry, links and anchors resolve |

## Not verified

To be clear about the limits:

- **Browsers.** Automated checks run in Chromium only. Firefox and Safari
  (including Safari on iOS) are not tested automatically; AudioWorklet,
  WebMIDI and file handling differ between them.
- **Real phones and tablets.** The phone sizes are emulated in desktop
  Chromium. Touch gestures, the on-screen keyboard and audio latency on real
  devices have not been checked systematically.
- **MIDI hardware.** Only the mapping from MIDI messages to notes is tested,
  never a real keyboard or controller.
- **Jam across networks.** The sync protocol is tested in-process. A real
  WebRTC connection between two machines, especially behind NAT (only a public
  STUN server is used, no TURN relay), has not been tested in CI.
- **Long sessions.** Memory use and timing drift over hours of playback or
  editing are not measured.
- **Exact sound.** Matching libopenmpt and ProTracker within the score above
  means the same notes, effects and timing; it does not mean bit-identical
  output. Resampling and ramping differ by design.
- **S3M and IT playback** against their original trackers, as said above.
