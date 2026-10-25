# webtracker

A chiptune tracker for the browser, made for the demoscene. Classic tracker interface, responsive on desktop, tablet and phone, with XM as its native format.

**Start it right in your browser: https://wirehack7.github.io/webtracker/**

The site can be installed as an app and then works offline as well. Songs are backed up in the browser as you work; the Save dialog brings back the latest versions and keeps a library of named songs. Share puts the whole song, compressed, into a link that opens it again, with no server involved.

## Development

Requirements: Node 22 and pnpm 10 (`corepack enable` is enough).

```sh
pnpm install
pnpm dev        # dev server
pnpm test       # Vitest
pnpm typecheck  # TypeScript for all packages
pnpm build      # production build into packages/app/dist
```

Render a module offline (same replayer as in the browser, output as WAV):

```sh
pnpm --filter @webtracker/formats render song.xm out.wav [seconds]
```

Robustness run over a folder of real modules (load and render 10 s each, no NaN):

```sh
MODULE_DIR=~/mods pnpm test
```

## Layout

| Package | Contents |
| --- | --- |
| `packages/engine` | Song model, replayer, mixer. No DOM dependency; runs in the AudioWorklet, in the export worker and under Node. |
| `packages/formats` | Loading MOD (ProTracker, xCHN, Soundtracker), XM 1.04, S3M (Scream Tracker 3), IT (Impulse Tracker, including compressed samples), MTM (MultiTracker), 669 (Composer 669, UNIS 669) and OKT (Oktalyzer), also packed in ZIP, gzip, MMCMP, PowerPacker or UMX, saving XM, MOD, XI and 8SVX samples, XP pattern and XT track files, sample import (WAV, AIFF, 8SVX, XI, Gravis PAT, raw PCM), WAV and ZIP writers for export. |
| `packages/app` | Vite app: UI, AudioWorklet and export worker in `src/audio/`, autosave in `src/storage/`, service worker for offline use. |

Every push to `main` is deployed to GitHub Pages.

## Usage

The keys follow the FT2 layout. The Help button in the app shows the full list. The essentials:

| Key | Action |
| --- | --- |
| Space | Stop, otherwise edit mode (Rec) on/off |
| Enter / Shift+Enter | Play song / pattern |
| Z–M, Q–U | Notes (by physical key), F1–F7 octave (also Numpad / and * or Ctrl+↑/↓), 1 or ` key-off |
| 0–9, A–F | Instrument, volume, effect and parameter in edit mode |
| Shift+arrows, mouse drag | Select a block; Ctrl+C/X/V copy, cut, paste |
| Alt+↑/↓ | Transpose (with Shift by an octave) |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S | Save as XM; the Save button also saves MOD and exports WAV (whole song or one file per channel) |
| Click / right-click a scope | Mute / solo a channel |
| Ctrl+I | Interpolate the volume column or effect across the selection |
| Ctrl+E / Edit button | Transpose with instrument filter, remap instruments, scale volume (selection, track, pattern or whole song), clean up the song (unused or duplicate patterns, unused instruments and samples, sample data after the loop) |
| Ctrl+Enter | Play the pattern from the cursor row (with Shift the song) |
| Alt+Enter | Play only the cursor row and step down, to go through a pattern row by row |
| F9–F12 | Jump to row 0, ¼, ½ and ¾ of the pattern |
| Shift+M / Shift+U | Mute the cursor channel / unmute all |
| Ctrl+F | Follow song on/off |
| Setup: Prospective view, Cursor wraps | Show the neighbouring patterns dimmed around the current one; stop the cursor at the first and last row |
| Alt+PageUp/PageDown | Previous/next song tab (new, loaded and shared songs open in tabs; Setup can turn this off) |
| Shift / Ctrl / Alt + F3–F5 | Cut, copy, paste the track / pattern / selection (Ctrl+F4 and Alt+F4 belong to the browser: copy the pattern with Ctrl+Shift+F4, the selection with Ctrl+C) |
| Alt+Q…I, Alt+A…K | Jump to channel 1–8 or 9–16 |

Besides cutting, normalizing, fades and resampling, the sample editor has tools to repair and shape samples: invert the phase, swap sign and byte order (for wrongly imported raw data), remove DC offset, reduce to 8 bits, low-pass and high-pass, loop crossfade, resample to any length, change the volume by any amount or as a ramp (Amp), draw the waveform by hand (Draw) and save as WAV or Amiga IFF 8SVX.

Setup sets the sound: resampling (Auto plays MOD through the Amiga 500 filter, where E00/E01 switch the LED filter, and XM with linear interpolation; also Linear, Cubic, an 8-tap Sinc and no interpolation at all) the stereo width from mono to 200 % and the overall loudness (Amplify, 25–400 %). WAV export uses the same settings. Edit colours under Setup changes any colour of the scheme; the colours can be exported and imported as a file.
