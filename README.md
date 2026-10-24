# webtracker

Ein Chiptune-Tracker für den Browser, für die Demoscene. Klassische Tracker-Oberfläche, responsive für Desktop, Tablet und Handy, mit XM als Hausformat.

## Entwicklung

Voraussetzungen: Node 22 und pnpm 10 (`corepack enable` reicht).

```sh
pnpm install
pnpm dev        # Dev-Server
pnpm test       # Vitest
pnpm typecheck  # TypeScript für alle Pakete
pnpm build      # Produktions-Build nach packages/app/dist
```

Module offline rendern (gleicher Replayer wie im Browser, Ausgabe als WAV):

```sh
pnpm --filter @webtracker/formats render song.xm out.wav [Sekunden]
```

Robustheitslauf über einen Ordner mit echten Modulen (laden und 10 s rendern, ohne NaN):

```sh
MODULE_DIR=~/mods pnpm test
```

## Aufbau

| Paket | Inhalt |
| --- | --- |
| `packages/engine` | Song-Modell, Replayer, Mixer. Keine DOM-Abhängigkeit, läuft im AudioWorklet, im Export-Worker und unter Node. |
| `packages/formats` | Parser für MOD (ProTracker, xCHN, Soundtracker) und XM 1.04. Writer folgen. |
| `packages/app` | Vite-App: UI, AudioWorklet-Wrapper unter `src/audio/`. |

Jeder Push auf `main` wird nach GitHub Pages deployt.

## Bedienung

Die Oberfläche ist auf Englisch und folgt der FT2-Belegung. Die vollständige Tastenliste zeigt der Button „Help“ in der App. Das Wichtigste:

| Taste | Funktion |
| --- | --- |
| Leertaste | Stop, sonst Edit-Modus (Rec) an/aus |
| Enter / Shift+Enter | Song / Pattern abspielen |
| Z–M, Q–U | Noten (nach physischer Taste), F1–F7 Oktave, 1 oder ` Key-Off |
| 0–9, A–F | Instrument, Volume, Effekt und Parameter im Edit-Modus |
| Shift+Pfeile, Maus ziehen | Block markieren; Strg+C/X/V kopieren, ausschneiden, einfügen |
| Alt+↑/↓ | Transponieren (mit Shift um eine Oktave) |
| Strg+Z / Strg+Y | Undo / Redo |
| Strg+S | Als XM speichern |
