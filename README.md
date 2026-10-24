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

## Aufbau

| Paket | Inhalt |
| --- | --- |
| `packages/engine` | Song-Modell, Replayer, Mixer. Keine DOM-Abhängigkeit, läuft im AudioWorklet, im Export-Worker und unter Node. |
| `packages/formats` | Parser und Writer für MOD und XM (folgt mit Phase 1). |
| `packages/app` | Vite-App: UI, AudioWorklet-Wrapper unter `src/audio/`. |

Jeder Push auf `main` wird nach GitHub Pages deployt.
