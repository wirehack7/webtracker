# webtracker

Ein Chiptune-Tracker für den Browser, für die Demoscene. Klassische Tracker-Oberfläche, responsive für Desktop, Tablet und Handy, mit XM als Hausformat.

**Direkt im Browser starten: https://wirehack7.github.io/webtracker/**

Die Seite lässt sich als App installieren und läuft danach auch offline. Songs werden laufend im Browser gesichert, die letzten Versionen holt der Save-Dialog zurück.

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
| `packages/formats` | Laden von MOD (ProTracker, xCHN, Soundtracker) und XM 1.04, Speichern als XM, MOD und XI, Sample-Import (WAV, AIFF, 8SVX, XI), WAV- und ZIP-Writer für den Export. |
| `packages/app` | Vite-App: UI, AudioWorklet und Export-Worker unter `src/audio/`, Autosave unter `src/storage/`, Service Worker für den Offline-Betrieb. |

Jeder Push auf `main` wird nach GitHub Pages deployt.

## Bedienung

Die Oberfläche ist auf Englisch und folgt der FT2-Belegung. Die vollständige Tastenliste zeigt der Button „Help“ in der App. Das Wichtigste:

| Taste | Funktion |
| --- | --- |
| Leertaste | Stop, sonst Edit-Modus (Rec) an/aus |
| Enter / Shift+Enter | Song / Pattern abspielen |
| Z–M, Q–U | Noten (nach physischer Taste), F1–F7 Oktave (auch Numpad / und * oder Strg+↑/↓), 1 oder ` Key-Off |
| 0–9, A–F | Instrument, Volume, Effekt und Parameter im Edit-Modus |
| Shift+Pfeile, Maus ziehen | Block markieren; Strg+C/X/V kopieren, ausschneiden, einfügen |
| Alt+↑/↓ | Transponieren (mit Shift um eine Oktave) |
| Strg+Z / Strg+Y | Undo / Redo |
| Strg+S | Als XM speichern; der Button „Save“ speichert auch als MOD und exportiert WAV (ganzer Song oder ein File pro Kanal) |
| Klick / Rechtsklick auf ein Scope | Kanal stummschalten / solo |
| Strg+I | Lautstärke-Spalte oder Effekt im markierten Bereich interpolieren |
| Strg+E / Button „Edit“ | Transponieren mit Instrument-Filter, Instrumente umnummerieren, Lautstärke skalieren (Auswahl, Track, Pattern oder ganzer Song) |
| Strg+Enter | Pattern ab der Cursor-Zeile spielen (mit Shift den Song) |
| F9–F12 | Zu Zeile 0, ¼, ½ und ¾ des Patterns springen |
| Shift+M / Shift+U | Kanal unter dem Cursor stumm / alle wieder an |
| Strg+F | Song folgen an/aus |
| Shift / Strg / Alt + F3–F5 | Track / Pattern / Auswahl ausschneiden, kopieren, einfügen (Strg+F4 und Alt+F4 gehören dem Browser: Pattern kopieren mit Strg+Shift+F4, Auswahl mit Strg+C) |
| Alt+Q…I, Alt+A…K | Zu Kanal 1–8 bzw. 9–16 springen |

Im Sample-Editor gibt es neben Schneiden, Normalisieren, Fades und Resample auch Werkzeuge zum Reparieren und Formen: Phase umkehren, Vorzeichen und Byte-Reihenfolge tauschen (für falsch importierte Rohdaten), DC-Offset entfernen, auf 8 Bit reduzieren, Tief- und Hochpass, Loop-Crossfade, Resample auf beliebige Länge und „Save“ als WAV.

Unter „Setup“ lässt sich der Klang einstellen: Resampling (Auto spielt MOD über den Amiga-500-Filter, bei dem E00/E01 das LED-Filter schalten, und XM linear interpoliert; dazu Linear, Cubic und ganz ohne Interpolation) sowie die Stereo-Breite von Mono bis 200 %. Der WAV-Export verwendet dieselben Einstellungen.
