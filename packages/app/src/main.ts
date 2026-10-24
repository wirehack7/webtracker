import '@fontsource/press-start-2p/400.css';
import './style.css';
import {
  blockBetween,
  clearBlock,
  copyBlock,
  createSong,
  deleteRow,
  insertRow,
  MAX_PATTERNS,
  NOTE_KEY_OFF,
  noteName,
  pasteClip,
  readCell,
  resizePattern,
  transposeBlock,
  writeCell,
  type Cell,
  type Clip,
  type PlayerState,
  type Song,
} from '@webtracker/engine';
import { loadModule, saveXm } from '@webtracker/formats';
import { EngineNode } from './audio/engine.ts';
import type { WorkletMessage } from './audio/messages.ts';
import { enterEffect, enterInstrument, enterParam, enterVolume } from './editor/entry.ts';
import { SongEditor } from './editor/song-editor.ts';
import { noteForKey, octaveForKey } from './keyboard.ts';
import { PatternEditor } from './ui/pattern-editor.ts';
import { Column, hex } from './ui/pattern-view.ts';
import { mountPiano } from './ui/piano.ts';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const app = $<HTMLDivElement>('#app');
const status = $<HTMLSpanElement>('#status');
const patternEl = $<HTMLDivElement>('#pattern');
const view = new PatternEditor(patternEl);

const settings = { add: 1, octave: 4 };
const limits = { bpm: [32, 255], speed: [1, 31], add: [0, 16], octave: [0, 7] } as const;
let instrument = 1;
let recording = false;
let playing = false;
/** Position in the order list whose pattern the editor shows. */
let currentOrder = 0;
let clipboard: Clip | null = null;

// ---- Audio ---------------------------------------------------------------

let engine: EngineNode | null = null;
let starting: Promise<EngineNode | null> | null = null;
let sounding: number | null = null;

const editor = new SongEditor(createSong(8), (message) => engine?.send(message));

/** Starts audio on the first key or tap, browsers only allow it from a gesture. */
function ensureEngine(): Promise<EngineNode | null> {
  starting ??= EngineNode.start().then(
    (node) => {
      engine = node;
      node.onMessage = handleWorkletMessage;
      node.send({ type: 'load', song: editor.song });
      status.textContent = `Audio running at ${node.context.sampleRate} Hz.`;
      return node;
    },
    (error: unknown) => {
      starting = null;
      status.textContent = `Audio could not start: ${String(error)}`;
      return null;
    },
  );
  return starting;
}

async function previewOn(note: number): Promise<void> {
  sounding = note;
  const node = engine ?? (await ensureEngine());
  if (!node || sounding !== note) return;
  node.send({ type: 'noteOn', note });
}

function previewOff(note: number): void {
  if (sounding !== note) return;
  sounding = null;
  engine?.send({ type: 'noteOff' });
}

/** A note from the keyboard or piano: sounds it, and writes it in edit mode. */
function playNote(note: number): void {
  if (recording && view.column === Column.Note) {
    editCell('note', { note, instrument });
    advance();
  }
  void previewOn(note);
  status.textContent = `${noteName(note)}  Instr ${hex(instrument)}  Channel ${view.channel + 1}`;
}

// ---- Editing -------------------------------------------------------------

const song = (): Song => editor.song;
const currentPatternIndex = (): number => song().orders[currentOrder] ?? 0;

function editCell(label: string, cell: Partial<Cell>): void {
  editor.editPattern(view.patternIndex, label, (p) => writeCell(song(), p, view.row, view.channel, cell));
}

function cursorCell(): Cell {
  return readCell(song(), view.pattern, view.row, view.channel);
}

/** Moves down by the Add step after an entry, like FT2. */
function advance(): void {
  if (settings.add > 0) view.moveTo(view.row + settings.add, view.channel);
}

/** Hex and letter entry into the instrument, volume and effect columns. */
function typeIntoColumn(key: string): boolean {
  const cell = cursorCell();
  const column = view.column;
  const high = column === Column.InsHi || column === Column.VolHi || column === Column.ParamHi;
  let change: Partial<Cell> | null = null;
  if (column === Column.InsHi || column === Column.InsLo) {
    const v = enterInstrument(cell.instrument, high, key);
    if (v !== null) change = { instrument: v };
  } else if (column === Column.VolHi || column === Column.VolLo) {
    const v = enterVolume(cell.volume, high, key);
    if (v !== null) change = { volume: v };
  } else if (column === Column.Effect) {
    const v = enterEffect(key);
    if (v !== null) change = { effect: v };
  } else if (column === Column.ParamHi || column === Column.ParamLo) {
    const v = enterParam(cell.param, high, key);
    if (v !== null) change = { param: v };
  }
  if (!change) return false;
  editCell('entry', change);
  advance();
  return true;
}

/** Del: clears the selection, or the field under the cursor. */
function clearAtCursor(): void {
  if (view.selection) {
    const block = view.selection;
    editor.editPattern(view.patternIndex, 'clear', (p) => clearBlock(song(), p, block));
    return;
  }
  const column = view.column;
  if (column === Column.Note) editCell('clear', { note: 0, instrument: 0 });
  else if (column <= Column.InsLo) editCell('clear', { instrument: 0 });
  else if (column <= Column.VolLo) editCell('clear', { volume: 0 });
  else editCell('clear', { effect: 0, param: 0 });
  advance();
}

function copySelection(cut: boolean): void {
  const block = view.blockOrCursor();
  clipboard = copyBlock(song(), view.pattern, block);
  if (cut) editor.editPattern(view.patternIndex, 'cut', (p) => clearBlock(song(), p, block));
  status.textContent = `${cut ? 'Cut' : 'Copied'} ${clipboard.rows} rows × ${clipboard.channels} channels.`;
}

function paste(mix: boolean): void {
  const clip = clipboard;
  if (!clip) return;
  editor.editPattern(view.patternIndex, 'paste', (p) => pasteClip(song(), p, view.row, view.channel, clip, mix));
  view.setSelection(blockBetween(view.row, view.channel, view.row + clip.rows - 1, view.channel + clip.channels - 1));
}

function transpose(semitones: number): void {
  const block = view.blockOrCursor();
  editor.editPattern(view.patternIndex, 'transpose', (p) => {
    transposeBlock(song(), p, block, semitones);
  });
}

function changeLength(delta: number): void {
  const rows = Math.max(1, Math.min(256, view.pattern.rows + delta));
  editor.editPattern(view.patternIndex, 'length', (p) => resizePattern(song(), p, rows));
}

// ---- Panels --------------------------------------------------------------

function fillList(list: HTMLElement, count: number, start: number, label: (i: number) => string, selected = start) {
  const items: HTMLLIElement[] = Array.from({ length: count }, (_, k) => {
    const i = k + start;
    const li = document.createElement('li');
    li.dataset.index = String(i);
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = hex(i);
    li.append(idx, ` ${label(i)}`);
    li.setAttribute('aria-selected', String(i === selected));
    return li;
  });
  list.replaceChildren(...items);
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  // Lists are refilled on every change, so the click handler is added only once.
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
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function fillOrders(): void {
  const s = song();
  fillList($('#orders'), s.orders.length, 0, (i) => hex(s.orders[i] ?? 0), currentOrder);
}

function fillInstruments(): void {
  const s = song();
  fillList($('#instrument-list'), Math.max(128, s.instruments.length), 1, (i) => s.instruments[i - 1]?.name ?? '', instrument);
  fillSampleList();
}

function fillSampleList(): void {
  const samples = song().instruments[instrument - 1]?.samples ?? [];
  fillList($('#sample-list'), Math.max(16, samples.length), 0, (i) => samples[i]?.name ?? '');
}

function showValue(id: string, value: number, decimal = false): void {
  $<HTMLOutputElement>(`#${id}`).textContent = decimal ? String(value) : hex(value);
}

/** Shows the pattern at the current order position and the song fields. */
function showPosition(): void {
  const index = currentPatternIndex();
  view.show(song(), index);
  showValue('pattern-no', index);
  showValue('pattern-len', view.pattern.rows, true);
  selectListItem($('#orders'), currentOrder);
}

function showSong(): void {
  const s = song();
  currentOrder = Math.min(currentOrder, s.orders.length - 1);
  instrument = Math.min(Math.max(1, instrument), Math.max(1, s.instruments.length));
  showValue('bpm', s.initialTempo, true);
  showValue('speed', s.initialSpeed);
  fillOrders();
  fillInstruments();
  buildScopes(s.channels);
  showPosition();
}

editor.onChange = () => {
  fillOrders();
  showPosition();
};

$('#instrument-list').addEventListener('select', (event) => {
  instrument = (event as CustomEvent<number>).detail;
  fillSampleList();
});
$('#orders').addEventListener('select', (event) => {
  currentOrder = (event as CustomEvent<number>).detail;
  if (playing) engine?.send({ type: 'seek', order: currentOrder });
  showPosition();
});

$('#order-ins').addEventListener('click', () => {
  const at = currentOrder;
  editor.editOrders('insert position', (o) => [...o.slice(0, at + 1), o[at] ?? 0, ...o.slice(at + 1)]);
  currentOrder = Math.min(at + 1, song().orders.length - 1);
  fillOrders();
  showPosition();
});
$('#order-del').addEventListener('click', () => {
  const at = currentOrder;
  editor.editOrders('delete position', (o) => o.filter((_, i) => i !== at));
  currentOrder = Math.min(at, song().orders.length - 1);
  fillOrders();
  showPosition();
});
for (const [id, delta] of [['#order-dec', -1], ['#order-inc', 1]] as const) {
  $(id).addEventListener('click', () => {
    const at = currentOrder;
    const next = Math.max(0, Math.min(MAX_PATTERNS - 1, (song().orders[at] ?? 0) + delta));
    editor.editOrders('pattern number', (o) => o.map((p, i) => (i === at ? next : p)));
  });
}

$('#len-dec').addEventListener('click', (event) => changeLength(event.shiftKey ? -16 : -1));
$('#len-inc').addEventListener('click', (event) => changeLength(event.shiftKey ? 16 : 1));

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-step]')) {
  button.addEventListener('click', () => {
    const [key, delta] = button.dataset.step!.split(':') as [keyof typeof limits, string];
    step(key, Number(delta));
  });
}

function step(key: keyof typeof limits, delta: number): void {
  const [min, max] = limits[key];
  const clampTo = (v: number) => Math.min(max, Math.max(min, v));
  const s = song();
  if (key === 'bpm' || key === 'speed') {
    const speed = key === 'speed' ? clampTo(s.initialSpeed + delta) : s.initialSpeed;
    const tempo = key === 'bpm' ? clampTo(s.initialTempo + delta) : s.initialTempo;
    editor.setTempo(speed, tempo);
    showValue('bpm', tempo, true);
    showValue('speed', speed);
    return;
  }
  settings[key] = clampTo(settings[key] + delta);
  showValue(key, settings[key]);
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

// ---- Playback ------------------------------------------------------------

function handleWorkletMessage(message: WorkletMessage): void {
  showPlayerState(message.state);
  if (message.type !== 'row') return;
  scopes.querySelectorAll('canvas').forEach((canvas, c) => drawScope(canvas, c, message.levels[c] ?? 0));
}

function showPlayerState(state: PlayerState): void {
  playing = state.playing;
  if (!playing) return;
  showValue('bpm', state.tempo, true);
  showValue('speed', state.speed);
  if (state.order !== currentOrder) {
    currentOrder = state.order;
    selectListItem($('#orders'), currentOrder);
  }
  // While playing, the cursor rides on the playing row, so edit mode records there.
  const changedPattern = state.pattern !== view.patternIndex;
  view.follow(state.pattern, state.row);
  if (changedPattern) {
    showValue('pattern-no', state.pattern);
    showValue('pattern-len', view.pattern.rows, true);
  }
}

async function play(loopPattern: boolean): Promise<void> {
  const node = engine ?? (await ensureEngine());
  if (!node) return;
  node.send({ type: 'play', loopPattern, order: currentOrder });
  playing = true;
}

function stop(): void {
  engine?.send({ type: 'stop' });
  playing = false;
  showValue('bpm', song().initialTempo, true);
  showValue('speed', song().initialSpeed);
}

function setRecording(on: boolean): void {
  recording = on;
  $('#rec').setAttribute('aria-pressed', String(on));
  patternEl.classList.toggle('rec', on);
}

// ---- Files ---------------------------------------------------------------

const fileInput = $<HTMLInputElement>('#file');

function confirmDiscard(): boolean {
  return !editor.dirty || confirm('Discard the changes to the current song?');
}

function startSong(next: Song): void {
  stop();
  currentOrder = 0;
  editor.replaceSong(next);
  view.moveTo(0, 0, Column.Note);
  showSong();
}

async function openModule(file: File): Promise<void> {
  if (!confirmDiscard()) return;
  try {
    const loaded = loadModule(await file.arrayBuffer(), file.name);
    startSong(loaded);
    status.textContent = `${file.name}: ${loaded.title || 'untitled'}, ${loaded.formatName}, ${loaded.channels} channels.`;
  } catch (error) {
    status.textContent = `Could not load ${file.name}: ${(error as Error).message}`;
  }
}

function saveSong(): void {
  const s = song();
  const bytes = saveXm(s);
  const name = (s.title.trim() || 'untitled').replace(/[^\w .-]+/g, '_');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/xm' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.xm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  editor.dirty = false;
  status.textContent = `Saved ${name}.xm (${bytes.length} bytes).`;
}

$('#new').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  startSong(createSong(8));
  status.textContent = 'New song: 8 channels, five chip instruments.';
});
$('#load').addEventListener('click', () => fileInput.click());
$('#save').addEventListener('click', saveSong);
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
window.addEventListener('beforeunload', (event) => {
  if (editor.dirty) event.preventDefault();
});

// ---- Buttons and layout --------------------------------------------------

$('#rec').addEventListener('click', () => setRecording(!recording));
$('#play-song').addEventListener('click', () => void play(false));
$('#play-pattern').addEventListener('click', () => void play(true));
$('#stop').addEventListener('click', stop);

const help = $<HTMLDialogElement>('#help');
$('#help-open').addEventListener('click', () => help.showModal());

// Buttons hand focus back to the pattern, so Space and Enter never press them twice.
document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('.btn');
  if (button && !help.contains(button)) patternEl.focus({ preventScroll: true });
});

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
  down: (semitone) => playNote(settings.octave * 12 + semitone + 1),
  up: (semitone) => previewOff(settings.octave * 12 + semitone + 1),
});

// ---- Keyboard ------------------------------------------------------------

const KEY_OFF_KEYS = new Set(['Digit1', 'Backquote', 'IntlBackslash']);
const heldKeys = new Map<string, number>();

/** Ctrl/Cmd shortcuts. Returns true when the key was handled. */
function handleCommand(event: KeyboardEvent): boolean {
  switch (event.code) {
    case 'KeyZ': {
      const label = event.shiftKey ? editor.redo() : editor.undo();
      status.textContent = label ? `${event.shiftKey ? 'Redo' : 'Undo'}: ${label}` : 'Nothing to undo.';
      return true;
    }
    case 'KeyY': {
      const label = editor.redo();
      status.textContent = label ? `Redo: ${label}` : 'Nothing to redo.';
      return true;
    }
    case 'KeyC':
      copySelection(false);
      return true;
    case 'KeyX':
      copySelection(true);
      return true;
    case 'KeyV':
      paste(event.shiftKey);
      return true;
    case 'KeyA':
      view.setSelection(blockBetween(0, 0, view.pattern.rows - 1, song().channels - 1));
      return true;
    case 'KeyS':
      saveSong();
      return true;
    case 'KeyO':
      fileInput.click();
      return true;
  }
  return false;
}

/** Cursor keys. Returns true when the key was handled. */
function handleMove(event: KeyboardEvent): boolean {
  const extend = event.shiftKey;
  const rows = view.pattern.rows;
  switch (event.code) {
    case 'ArrowUp':
      view.moveTo(view.row - 1, view.channel, view.column, extend);
      return true;
    case 'ArrowDown':
      view.moveTo(view.row + 1, view.channel, view.column, extend);
      return true;
    case 'ArrowLeft':
      if (extend) view.moveTo(view.row, view.channel - 1, view.column, true);
      else view.moveColumn(-1);
      return true;
    case 'ArrowRight':
      if (extend) view.moveTo(view.row, view.channel + 1, view.column, true);
      else view.moveColumn(1);
      return true;
    case 'PageUp':
      view.moveTo(Math.max(0, view.row - 16), view.channel, view.column, extend);
      return true;
    case 'PageDown':
      view.moveTo(Math.min(rows - 1, view.row + 16), view.channel, view.column, extend);
      return true;
    case 'Home':
      view.moveTo(0, view.channel, view.column, extend);
      return true;
    case 'End':
      view.moveTo(rows - 1, view.channel, view.column, extend);
      return true;
    case 'Tab':
      view.moveTo(view.row, view.channel + (event.shiftKey ? -1 : 1), Column.Note);
      return true;
  }
  return false;
}

window.addEventListener('keydown', (event) => {
  if (help.open) return;
  const target = event.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

  if (event.ctrlKey || event.metaKey) {
    if (!event.altKey && handleCommand(event)) event.preventDefault();
    return;
  }

  if (event.altKey) {
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.preventDefault();
      transpose((event.code === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1));
    }
    return;
  }

  if (handleMove(event)) {
    event.preventDefault();
    return;
  }
  if (event.repeat) return;

  const newOctave = octaveForKey(event.code);
  if (newOctave !== null) {
    event.preventDefault();
    settings.octave = newOctave;
    showValue('octave', newOctave);
    return;
  }

  switch (event.code) {
    case 'Escape':
      view.setSelection(null);
      return;
    case 'Space':
      event.preventDefault();
      if (playing) stop();
      else setRecording(!recording);
      return;
    case 'Enter':
    case 'NumpadEnter':
      event.preventDefault();
      void play(event.shiftKey);
      return;
  }

  if (recording) {
    switch (event.code) {
      case 'Delete':
        event.preventDefault();
        clearAtCursor();
        return;
      case 'Insert': {
        event.preventDefault();
        const [ch0, ch1] = event.shiftKey ? [0, song().channels - 1] : [view.channel, view.channel];
        editor.editPattern(view.patternIndex, 'insert row', (p) => insertRow(song(), p, view.row, ch0, ch1));
        return;
      }
      case 'Backspace': {
        event.preventDefault();
        if (view.row === 0) return;
        const [ch0, ch1] = event.shiftKey ? [0, song().channels - 1] : [view.channel, view.channel];
        const row = view.row - 1;
        editor.editPattern(view.patternIndex, 'delete row', (p) => deleteRow(song(), p, row, ch0, ch1));
        view.moveTo(row, view.channel);
        return;
      }
    }
    if (view.column === Column.Note && KEY_OFF_KEYS.has(event.code)) {
      event.preventDefault();
      editCell('key off', { note: NOTE_KEY_OFF, instrument: 0 });
      advance();
      return;
    }
    if (view.column !== Column.Note) {
      if (typeIntoColumn(event.key)) event.preventDefault();
      return;
    }
  }

  const note = noteForKey(event.code, settings.octave);
  if (note === null) return;
  event.preventDefault();
  heldKeys.set(event.code, note);
  playNote(note);
});

window.addEventListener('keyup', (event) => {
  const note = heldKeys.get(event.code);
  if (note === undefined) return;
  heldKeys.delete(event.code);
  previewOff(note);
});

view.onCursor = () => {
  status.textContent = `Row ${hex(view.row)}  Channel ${view.channel + 1}`;
};

showSong();
