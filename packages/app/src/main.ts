import '@fontsource/press-start-2p/400.css';
import './style.css';
import { noteName, type PlayerState, type Song } from '@webtracker/engine';
import { loadModule } from '@webtracker/formats';
import { EngineNode } from './audio/engine.ts';
import type { WorkletMessage } from './audio/messages.ts';
import { noteForKey, octaveForKey } from './keyboard.ts';
import { CHANNELS, hex, PatternPlaceholder } from './ui/pattern-placeholder.ts';
import { highlightRow, renderPattern } from './ui/pattern-view.ts';
import { mountPiano } from './ui/piano.ts';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const app = $<HTMLDivElement>('#app');
const status = $<HTMLSpanElement>('#status');
const pattern = new PatternPlaceholder($('#pattern'));

const settings = { bpm: 125, speed: 6, add: 1, octave: 4 };
const limits: Record<keyof typeof settings, [number, number]> = {
  bpm: [32, 255],
  speed: [1, 31],
  add: [0, 16],
  octave: [0, 7],
};
let instrument = 1;
let recording = false;

// A loaded module replaces the placeholder editor until editing lands in the song model.
let song: Song | null = null;
let shownPattern = -1;
let patternRows: HTMLElement[] = [];

// ---- Audio ---------------------------------------------------------------

let engine: EngineNode | null = null;
let starting: Promise<EngineNode | null> | null = null;
let sounding: number | null = null;

/** Starts audio on the first key or tap, browsers only allow it from a gesture. */
function ensureEngine(): Promise<EngineNode | null> {
  starting ??= EngineNode.start().then(
    (node) => {
      engine = node;
      node.onMessage = handleWorkletMessage;
      if (song) node.send({ type: 'load', song });
      status.textContent = `Audio läuft mit ${node.context.sampleRate} Hz.`;
      return node;
    },
    (error: unknown) => {
      starting = null;
      status.textContent = `Audio konnte nicht starten: ${String(error)}`;
      return null;
    },
  );
  return starting;
}

async function noteOn(note: number): Promise<void> {
  if (recording && !song) {
    pattern.write(note, instrument);
    pattern.moveTo(pattern.row + settings.add, pattern.channel);
  }
  sounding = note;
  const node = engine ?? (await ensureEngine());
  if (!node || sounding !== note) return;
  node.send({ type: 'noteOn', note });
  status.textContent = `${noteName(note)}  Instr ${hex(instrument)}  Kanal ${pattern.channel + 1}`;
}

function noteOff(note: number): void {
  if (sounding !== note) return;
  sounding = null;
  engine?.send({ type: 'noteOff' });
}

// ---- Panels --------------------------------------------------------------

function fillList(list: HTMLElement, count: number, start: number, label: (i: number) => string) {
  const items: HTMLLIElement[] = Array.from({ length: count }, (_, k) => {
    const i = k + start;
    const li = document.createElement('li');
    li.dataset.index = String(i);
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = hex(i);
    li.append(idx, ` ${label(i)}`);
    return li;
  });
  list.replaceChildren(...items);
  items[0]?.setAttribute('aria-selected', 'true');
  // Lists are refilled when a module loads, so the click handler is added only once.
  if (list.dataset.bound) return;
  list.dataset.bound = 'true';
  list.addEventListener('click', (event) => {
    const li = (event.target as HTMLElement).closest('li');
    if (!li) return;
    selectListItem(list, Number(li.dataset.index));
    list.dispatchEvent(new CustomEvent('select', { detail: Number(li.dataset.index) }));
  });
}

function selectListItem(list: HTMLElement, index: number): void {
  for (const item of list.children) item.setAttribute('aria-selected', String((item as HTMLElement).dataset.index === String(index)));
}

fillList($('#orders'), 1, 0, () => '00');
fillList($('#instrument-list'), 128, 1, () => '');
fillList($('#sample-list'), 16, 0, () => '');
$('#instrument-list').addEventListener('select', (event) => {
  instrument = (event as CustomEvent<number>).detail;
  if (song) fillSampleList(song, instrument);
});
$('#orders').addEventListener('select', (event) => {
  if (song) engine?.send({ type: 'seek', order: (event as CustomEvent<number>).detail });
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-step]')) {
  button.addEventListener('click', () => {
    const [key, delta] = button.dataset.step!.split(':') as [keyof typeof settings, string];
    setSetting(key, settings[key] + Number(delta));
  });
}

function setSetting(key: keyof typeof settings, value: number): void {
  const [min, max] = limits[key];
  settings[key] = Math.min(max, Math.max(min, value));
  const output = $<HTMLOutputElement>(`#${key}`);
  output.textContent = key === 'bpm' ? String(settings[key]) : hex(settings[key]);
}

const scopes = $('#scopes');

function drawScope(canvas: HTMLCanvasElement, channel: number, level: number): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  // Until real scopes exist, the line thickens with the channel's output level.
  const h = Math.max(1, Math.round(Math.min(1, level) * 20));
  g.fillStyle = '#7fff8f';
  g.fillRect(0, 12 - (h >> 1), 64, h);
  g.fillStyle = '#5e7598';
  g.font = '8px "Press Start 2P"';
  g.fillText(String(channel + 1), 2, 9);
}

function buildScopes(count: number): void {
  const canvases = Array.from({ length: count }, (_, c) => {
    const canvas = document.createElement('canvas');
    canvas.className = 'scope';
    canvas.width = 64;
    canvas.height = 24;
    drawScope(canvas, c, 0);
    void document.fonts.ready.then(() => drawScope(canvas, c, 0));
    return canvas;
  });
  scopes.replaceChildren(...canvases);
}

buildScopes(CHANNELS);

// ---- Module playback -----------------------------------------------------

const fileInput = $<HTMLInputElement>('#file');

function handleWorkletMessage(message: WorkletMessage): void {
  showPlayerState(message.state);
  if (message.type !== 'row') return;
  scopes.querySelectorAll('canvas').forEach((canvas, c) => drawScope(canvas, c, message.levels[c] ?? 0));
}

function fillSampleList(s: Song, insNumber: number): void {
  const samples = s.instruments[insNumber - 1]?.samples ?? [];
  fillList($('#sample-list'), Math.max(16, samples.length), 0, (i) => samples[i]?.name ?? '');
}

function showPlayerState(state: PlayerState): void {
  if (!song) return;
  setSetting('bpm', state.tempo);
  setSetting('speed', state.speed);
  selectListItem($('#orders'), state.order);
  if (state.pattern !== shownPattern) {
    const p = song.patterns[state.pattern];
    patternRows = p ? renderPattern($('#pattern'), song, p) : [];
    shownPattern = state.pattern;
    $('#pattern-no').textContent = hex(state.pattern);
    $('#pattern-len').textContent = String(p?.rows ?? 0);
  }
  highlightRow($('#pattern'), patternRows, state.row);
}

async function openModule(file: File): Promise<void> {
  try {
    const loaded = loadModule(await file.arrayBuffer(), file.name);
    song = loaded;
    engine?.send({ type: 'stop' });
    engine?.send({ type: 'load', song: loaded });
    fillList($('#orders'), loaded.orders.length, 0, (i) => hex(loaded.orders[i] ?? 0));
    fillList($('#instrument-list'), loaded.instruments.length, 1, (i) => loaded.instruments[i - 1]?.name ?? '');
    instrument = 1;
    fillSampleList(loaded, 1);
    buildScopes(loaded.channels);
    shownPattern = -1;
    showPlayerState({
      order: 0,
      pattern: loaded.orders[0] ?? 0,
      row: 0,
      speed: loaded.initialSpeed,
      tempo: loaded.initialTempo,
      playing: false,
      loops: 0,
    });
    status.textContent = `${file.name}: ${loaded.title || 'ohne Titel'}, ${loaded.formatName}, ${loaded.channels} Kanäle.`;
  } catch (error) {
    status.textContent = `${file.name} konnte nicht geladen werden: ${(error as Error).message}`;
  }
}

async function play(loopPattern: boolean): Promise<void> {
  const node = engine ?? (await ensureEngine());
  if (!node) return;
  if (!song) {
    status.textContent = 'Erst ein MOD oder XM laden.';
    return;
  }
  node.send({ type: 'play', loopPattern });
}

$('#load').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openModule(file);
  fileInput.value = '';
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) void openModule(file);
});

const recButton = $<HTMLButtonElement>('#rec');
recButton.addEventListener('click', () => {
  recording = !recording;
  recButton.setAttribute('aria-pressed', String(recording));
});

$('#play-song').addEventListener('click', () => void play(false));
$('#play-pattern').addEventListener('click', () => void play(true));
$('#stop').addEventListener('click', () => engine?.send({ type: 'stop' }));

for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab-target]')) {
  tab.setAttribute('aria-selected', String(tab.dataset.tabTarget === app.dataset.tab));
  tab.addEventListener('click', () => {
    app.dataset.tab = tab.dataset.tabTarget!;
    for (const other of document.querySelectorAll('[data-tab-target]')) {
      other.setAttribute('aria-selected', String(other === tab));
    }
  });
}

// The piano shows by default on touch screens; the Keys button flips that.
const keysToggle = $<HTMLButtonElement>('#keys-toggle');
const coarse = matchMedia('(pointer: coarse)');
const syncKeysToggle = (): void => {
  const visible = app.classList.contains('show-piano') || (coarse.matches && !app.classList.contains('hide-piano'));
  keysToggle.setAttribute('aria-pressed', String(visible));
};
keysToggle.addEventListener('click', () => {
  const visible = keysToggle.getAttribute('aria-pressed') === 'true';
  app.classList.toggle('show-piano', !visible);
  app.classList.toggle('hide-piano', visible);
  syncKeysToggle();
});
syncKeysToggle();

mountPiano($('#piano'), 2, {
  down: (semitone) => void noteOn(settings.octave * 12 + semitone + 1),
  up: (semitone) => noteOff(settings.octave * 12 + semitone + 1),
});

// ---- Keyboard ------------------------------------------------------------

const MOVES: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  PageUp: [-16, 0],
  PageDown: [16, 0],
};
const heldKeys = new Map<string, number>();

window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

  const newOctave = octaveForKey(event.code);
  if (newOctave !== null) {
    event.preventDefault();
    setSetting('octave', newOctave);
    return;
  }

  const move = MOVES[event.code];
  if (move && !song) {
    event.preventDefault();
    pattern.moveTo(pattern.row + move[0], pattern.channel + move[1]);
    return;
  }

  if (event.code === 'Space') {
    event.preventDefault();
    recButton.click();
    return;
  }

  if (event.code === 'Delete' && recording) {
    event.preventDefault();
    pattern.write(0, 0);
    pattern.moveTo(pattern.row + settings.add, pattern.channel);
    return;
  }

  const note = noteForKey(event.code, settings.octave);
  if (note === null) return;
  event.preventDefault();
  heldKeys.set(event.code, note);
  void noteOn(note);
});

window.addEventListener('keyup', (event) => {
  const note = heldKeys.get(event.code);
  if (note === undefined) return;
  heldKeys.delete(event.code);
  noteOff(note);
});
