import '@fontsource/press-start-2p/400.css';
import './style.css';
import { noteName } from '@webtracker/engine';
import { EngineNode } from './audio/engine.ts';
import { noteForKey, octaveForKey } from './keyboard.ts';
import { CHANNELS, hex, PatternPlaceholder } from './ui/pattern-placeholder.ts';
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

// ---- Audio ---------------------------------------------------------------

let engine: EngineNode | null = null;
let starting: Promise<EngineNode | null> | null = null;
let sounding: number | null = null;

/** Starts audio on the first key or tap, browsers only allow it from a gesture. */
function ensureEngine(): Promise<EngineNode | null> {
  starting ??= EngineNode.start().then(
    (node) => {
      engine = node;
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
  if (recording) {
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
  const items = Array.from({ length: count }, (_, k) => {
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
  list.addEventListener('click', (event) => {
    const li = (event.target as HTMLElement).closest('li');
    if (!li) return;
    for (const item of items) item.setAttribute('aria-selected', String(item === li));
    list.dispatchEvent(new CustomEvent('select', { detail: Number(li.dataset.index) }));
  });
  items[0]?.setAttribute('aria-selected', 'true');
}

fillList($('#orders'), 1, 0, () => '00');
fillList($('#instrument-list'), 128, 1, () => '');
fillList($('#sample-list'), 16, 0, () => '');
$('#instrument-list').addEventListener('select', (event) => {
  instrument = (event as CustomEvent<number>).detail;
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
for (let c = 0; c < CHANNELS; c++) {
  const canvas = document.createElement('canvas');
  canvas.className = 'scope';
  canvas.width = 64;
  canvas.height = 24;
  const g = canvas.getContext('2d');
  if (g) {
    g.fillStyle = '#7fff8f';
    g.fillRect(0, 12, 64, 1);
    g.fillStyle = '#5e7598';
    g.font = '8px "Press Start 2P"';
    document.fonts.ready.then(() => g.fillText(String(c + 1), 2, 9));
  }
  scopes.append(canvas);
}

const recButton = $<HTMLButtonElement>('#rec');
recButton.addEventListener('click', () => {
  recording = !recording;
  recButton.setAttribute('aria-pressed', String(recording));
});

for (const id of ['#play-song', '#play-pattern', '#stop']) {
  $(id).addEventListener('click', () => {
    void ensureEngine();
    if (id !== '#stop') status.textContent = 'Wiedergabe kommt mit dem Player.';
  });
}

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
  if (move) {
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
