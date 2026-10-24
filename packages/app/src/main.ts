import '@fontsource/press-start-2p/400.css';
import './style.css';
import {
  blockBetween,
  clearBlock,
  copyBlock,
  createSong,
  deleteRow,
  emptySample,
  insertRow,
  interpolateBlock,
  MAX_CHANNELS,
  MAX_PATTERNS,
  NOTE_KEY_OFF,
  noteName,
  pasteClip,
  rateForTuning,
  patternBlock,
  readCell,
  remapInstrument,
  resizePattern,
  scaleVolumeBlock,
  transposeBlock,
  writeCell,
  type Block,
  type Cell,
  type Clip,
  type Pattern,
  type PlayerState,
  type Resampler,
  type Song,
} from '@webtracker/engine';
import { encodeWav, importSample, loadModule, sampleFromChannels, saveMod, saveXi, saveXm, type WavFormat } from '@webtracker/formats';
import { EngineNode } from './audio/engine.ts';
import type { ExportReply, ExportRequest } from './audio/export-worker.ts';
import type { EngineMessage, WorkletMessage } from './audio/messages.ts';
import { enterEffect, enterInstrument, enterParam, enterVolume } from './editor/entry.ts';
import { SongEditor } from './editor/song-editor.ts';
import { noteForKey, octaveForKey } from './keyboard.ts';
import { InstrumentEditor } from './ui/instrument-editor.ts';
import { PatternEditor } from './ui/pattern-editor.ts';
import { Column, hex } from './ui/pattern-view.ts';
import { mountPiano } from './ui/piano.ts';
import { SampleEditor } from './ui/sample-editor.ts';
import { applyOrigin, listAutosaves, writeAutosave, type Autosave } from './storage/autosave.ts';
import { loadSettings, midiToNote, saveSettings, THEMES, velocityToVolume, type Settings, type Theme } from './ui/settings.ts';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const app = $<HTMLDivElement>('#app');
const status = $<HTMLSpanElement>('#status');
const patternEl = $<HTMLDivElement>('#pattern');
const view = new PatternEditor(patternEl);
/** Browser preferences from the Setup dialog. */
const prefs: Settings = loadSettings();

const settings = { add: 1, octave: 4 };
const limits = { bpm: [32, 255], speed: [1, 31], add: [0, 16], octave: [0, 7], channels: [1, MAX_CHANNELS] } as const;
let instrument = 1;
/** 0-based sample slot of the current instrument, for the sample editor and keymap. */
let sampleSlot = 0;
let recording = false;
let playing = false;
/** Position in the order list whose pattern the editor shows. */
let currentOrder = 0;
let clipboard: Clip | null = null;
/** Muted channels, by index; they keep playing silently. */
let muted: boolean[] = [];
/** Ctrl+F: whether the pattern view rides along with playback. */
let followSong = true;

// ---- Audio ---------------------------------------------------------------

let engine: EngineNode | null = null;
let starting: Promise<EngineNode | null> | null = null;
let sounding: number | null = null;

const editor = new SongEditor(createSong(), (message) => engine?.send(message));

const host = {
  editor,
  instrumentIndex: () => instrument - 1,
  sampleIndex: () => sampleSlot,
  status: (text: string) => (status.textContent = text),
  importFile: () => $<HTMLInputElement>('#sample-file').click(),
  saveInstrument: () => saveInstrument(),
  saveSample: () => saveSample(),
};
const sampleEditor = new SampleEditor(host);
const instrumentEditor = new InstrumentEditor(host);
$('#editors').append(sampleEditor.root, instrumentEditor.root);

/** Starts audio on the first key or tap, browsers only allow it from a gesture. */
function ensureEngine(): Promise<EngineNode | null> {
  starting ??= EngineNode.start().then(
    (node) => {
      engine = node;
      node.onMessage = handleWorkletMessage;
      node.send({ type: 'load', song: editor.song });
      node.send({ type: 'mute', muted });
      node.send(mixerMessage());
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
  node.send({ type: 'noteOn', note, instrument });
}

function previewOff(note: number): void {
  if (sounding !== note) return;
  sounding = null;
  engine?.send({ type: 'noteOff' });
}

/** A note from the keyboard or piano: sounds it, and writes it in edit mode. */
function playNote(note: number, volume = 0): void {
  if (recording && view.column === Column.Note) {
    editCell('note', volume ? { note, instrument, volume } : { note, instrument });
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

// FT2 block keys: F3 cut, F4 copy, F5 paste; Shift for the track, Ctrl for
// the pattern, Alt for the selection. Ctrl+F4 and Alt+F4 belong to the
// browser and the system, so Ctrl+Shift+F4 also copies the pattern.
const BLOCK_ACTIONS: Record<string, 'cut' | 'copy' | 'paste'> = { F3: 'cut', F4: 'copy', F5: 'paste' };
// Alt+Q..I jumps to channels 1-8, Alt+A..K to 9-16, as in FT2.
const CHANNEL_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'];

function blockKey(event: KeyboardEvent): boolean {
  if (event.altKey && !event.ctrlKey && !event.shiftKey) {
    const channel = CHANNEL_KEYS.indexOf(event.code);
    if (channel >= 0) {
      if (channel < song().channels) view.moveTo(view.row, channel);
      return true;
    }
  }
  const action = BLOCK_ACTIONS[event.code];
  if (!action || !(event.shiftKey || event.ctrlKey || event.altKey)) return false;
  const scope = event.ctrlKey ? 'pattern' : event.shiftKey ? 'track' : 'block';
  const block =
    scope === 'block' ? view.blockOrCursor() : patternBlock(song(), view.pattern, scope === 'track' ? view.channel : undefined);
  if (action === 'paste') {
    const clip = clipboard;
    if (!clip) return true;
    const [row, channel] = scope === 'block' ? [view.row, view.channel] : [0, scope === 'track' ? view.channel : 0];
    editor.editPattern(view.patternIndex, `paste ${scope}`, (p) => pasteClip(song(), p, row, channel, clip));
    return true;
  }
  clipboard = copyBlock(song(), view.pattern, block);
  if (action === 'cut') editor.editPattern(view.patternIndex, `cut ${scope}`, (p) => clearBlock(song(), p, block));
  status.textContent = `${action === 'cut' ? 'Cut' : 'Copied'} ${scope}: ${clipboard.rows} rows × ${clipboard.channels} channels.`;
  return true;
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

/** Ctrl+I: interpolates the volume column or the effect under the cursor across the selection. */
function interpolateSelection(): void {
  const block = view.selection;
  if (!block || block.row1 - block.row0 < 2) {
    status.textContent = 'Select at least three rows to interpolate.';
    return;
  }
  const column = view.column >= Column.Effect ? 'effect' : 'volume';
  let changed = 0;
  editor.editPattern(view.patternIndex, 'interpolate', (p) => {
    changed = interpolateBlock(song(), p, block, column);
  });
  status.textContent = changed
    ? `Interpolated ${changed} ${column === 'effect' ? 'effect values' : 'volumes'}.`
    : `Nothing to interpolate: the first and last row need the same kind of ${column === 'effect' ? 'effect' : 'volume command'}.`;
}

const JUMP_KEYS: Record<string, number> = { F9: 0, F10: 1, F11: 2, F12: 3 };

type EditRange = 'selection' | 'track' | 'pattern' | 'song';

/** The patterns and the block within each that an Advanced Edit range covers. */
function rangeTargets(range: EditRange): { indices: number[]; block: (index: number) => Block } {
  const s = song();
  if (range === 'song') {
    const indices = s.patterns.map((_, i) => i);
    return { indices, block: (i) => patternBlock(s, s.patterns[i]!) };
  }
  const index = view.patternIndex;
  const selection = view.selection;
  const block =
    range === 'selection' && selection ? selection : patternBlock(s, view.pattern, range === 'pattern' ? undefined : view.channel);
  return { indices: [index], block: () => block };
}

function applyRange(range: EditRange, label: string, edit: (pattern: Pattern, block: Block) => number): number {
  const { indices, block } = rangeTargets(range);
  let changed = 0;
  editor.editPatterns(indices, label, (p) => {
    changed += edit(p, block(song().patterns.indexOf(p)));
  });
  return changed;
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
  fillList($('#sample-list'), 16, 0, (i) => samples[i]?.name ?? '', sampleSlot);
}

/** Redraws whichever sample or instrument editor is showing. */
function renderEditors(): void {
  if (app.dataset.view === 'sample') sampleEditor.render();
  else if (app.dataset.view === 'instrument') instrumentEditor.render();
}

function setView(name: string): void {
  app.dataset.view = name;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view-target]')) {
    b.setAttribute('aria-selected', String(b.dataset.viewTarget === name));
  }
  if (name === 'pattern') showPosition();
  renderEditors();
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
  $<HTMLOutputElement>('#channels').textContent = String(s.channels).padStart(2, '0');
  titleInput.value = s.title;
  fillOrders();
  fillInstruments();
  buildScopes(s.channels);
  showPosition();
}

editor.onChange = (label) => {
  scheduleAutosave();
  if (label === 'channels') {
    // The worklet rebuilt its player for the new layout, so playback has stopped.
    stop();
    muted = muted.slice(0, song().channels);
    engine?.send({ type: 'mute', muted });
    showSong();
    view.moveTo(view.row, Math.min(view.channel, song().channels - 1));
    return;
  }
  if (label === 'title') {
    titleInput.value = song().title;
    return;
  }
  fillOrders();
  showPosition();
  // Pattern edits do not touch instruments, so the lists only refresh for the rest.
  if (!['note', 'entry', 'clear', 'cut', 'paste', 'transpose', 'key off', 'insert row', 'delete row', 'length'].includes(label)) {
    fillInstruments();
  }
  renderEditors();
};

$('#instrument-list').addEventListener('select', (event) => {
  instrument = (event as CustomEvent<number>).detail;
  sampleSlot = 0;
  fillSampleList();
  sampleEditor.resetView();
  renderEditors();
});
$('#sample-list').addEventListener('select', (event) => {
  sampleSlot = (event as CustomEvent<number>).detail;
  sampleEditor.resetView();
  renderEditors();
});
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view-target]')) {
  b.addEventListener('click', () => setView(b.dataset.viewTarget!));
}
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

const titleInput = $<HTMLInputElement>('#title');
titleInput.addEventListener('change', () => editor.setTitle(titleInput.value));
titleInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === 'Escape') titleInput.blur();
});

let shiftHeld = false;
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-step]')) {
  button.addEventListener('pointerdown', (event) => (shiftHeld = event.shiftKey));
  button.addEventListener('click', () => {
    const [key, delta] = button.dataset.step!.split(':') as [keyof typeof limits, string];
    step(key, Number(delta) * (key === 'channels' && shiftHeld ? 2 : 1));
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
  if (key === 'channels') {
    const channels = clampTo(s.channels + delta);
    if (channels < s.channels && !confirm(`Remove channels ${channels + 1}–${s.channels} from every pattern? Undo brings them back.`)) return;
    editor.setChannels(channels);
    status.textContent = `${channels} channels.`;
    return;
  }
  if (key === 'octave') {
    setOctave(clampTo(settings.octave + delta));
    return;
  }
  settings[key] = clampTo(settings[key] + delta);
  showValue(key, settings[key]);
}

/** The base octave for the keyboard; `scroll` brings the on-screen piano along. */
function setOctave(octave: number, scroll = true): void {
  settings.octave = octave;
  showValue('octave', octave);
  if (scroll) piano.showOctave(octave);
}

const scopes = $('#scopes');
/** Latest snapshot per channel from the worklet; empty while stopped. */
let scopeData: Float32Array[] = [];
let scopesDirty = true;
/** Frames shown across one scope, about 11 ms at 44.1 kHz. */
const SCOPE_WINDOW = 512;

function buildScopes(count: number): void {
  const boxes = Array.from({ length: count }, (_, c) => {
    const box = document.createElement('div');
    box.className = 'scope';
    const label = document.createElement('span');
    label.className = 'scope-label';
    label.textContent = String(c + 1);
    box.append(document.createElement('canvas'), label);
    box.classList.toggle('muted', muted[c] === true);
    box.title = 'Click: mute, right-click: solo';
    return box;
  });
  scopes.replaceChildren(...boxes);
  scopeData = [];
  scopesDirty = true;
}

/** Start of the shown window: the first rising zero crossing, so waves stand still. */
function scopeTrigger(data: Float32Array): number {
  const last = data.length - SCOPE_WINDOW;
  for (let i = 1; i < last; i++) if (data[i - 1]! <= 0 && data[i]! > 0) return i;
  return Math.max(0, last);
}

function drawScopes(): void {
  requestAnimationFrame(drawScopes);
  if (!scopesDirty) return;
  scopesDirty = false;
  const css = getComputedStyle(document.documentElement);
  const ratio = devicePixelRatio || 1;
  // Draw on the device pixel grid with lines as thick as one theme pixel.
  const line = Math.max(1, Math.round(parseFloat(css.getPropertyValue('--px')) * ratio));
  const color = css.getPropertyValue('--scope-line').trim();
  scopes.querySelectorAll('canvas').forEach((canvas, c) => {
    const w = Math.round(canvas.clientWidth * ratio);
    const h = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const g = canvas.getContext('2d');
    if (!g || !w || !h) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = color;
    const mid = Math.round((h - line) / 2);
    const data = scopeData[c];
    if (!data || data.length < SCOPE_WINDOW) {
      g.fillRect(0, mid, w, line);
      return;
    }
    const start = scopeTrigger(data);
    const amp = ((h - line) / 2) * 0.85;
    let prev = mid;
    for (let x = 0; x < w; x += line) {
      const v = Math.max(-1, Math.min(1, data[start + Math.floor((x * SCOPE_WINDOW) / w)]!));
      const y = Math.round(mid - v * amp);
      // Join to the previous column so steep edges stay connected.
      const top = Math.min(prev, y);
      g.fillRect(x, top, line, Math.max(prev, y) - top + line);
      prev = y;
    }
  });
}

/** Click mutes a channel; right-click solos it, or unmutes all when it already is the only one playing. */
function setMuted(next: boolean[]): void {
  muted = next;
  engine?.send({ type: 'mute', muted });
  scopes.querySelectorAll('.scope').forEach((box, c) => box.classList.toggle('muted', muted[c] === true));
  const off = muted.filter(Boolean).length;
  status.textContent = off ? `Muted: ${muted.flatMap((m, c) => (m ? [c + 1] : [])).join(' ')}` : 'All channels on.';
}

function scopeIndex(event: MouseEvent): number {
  const box = (event.target as HTMLElement).closest('.scope');
  return box ? [...scopes.children].indexOf(box) : -1;
}

scopes.addEventListener('click', (event) => {
  const c = scopeIndex(event);
  if (c < 0) return;
  const next = Array.from({ length: song().channels }, (_, k) => muted[k] === true);
  next[c] = !next[c];
  setMuted(next);
});
scopes.addEventListener('contextmenu', (event) => {
  const c = scopeIndex(event);
  if (c < 0) return;
  event.preventDefault();
  const count = song().channels;
  const alreadySolo = Array.from({ length: count }, (_, k) => (muted[k] === true) === (k !== c)).every(Boolean);
  setMuted(Array.from({ length: count }, (_, k) => !alreadySolo && k !== c));
});

function clearScopes(): void {
  scopeData = [];
  scopesDirty = true;
}

new ResizeObserver(() => (scopesDirty = true)).observe(scopes);
requestAnimationFrame(drawScopes);

// ---- Playback ------------------------------------------------------------

function handleWorkletMessage(message: WorkletMessage): void {
  if (message.type === 'voices') {
    sampleEditor.showVoices(message.voices);
    instrumentEditor.showVoices(message.voices);
    return;
  }
  if (message.type === 'scopes') {
    if (playing) {
      scopeData = message.channels;
      scopesDirty = true;
    }
    return;
  }
  showPlayerState(message.state);
}

function showPlayerState(state: PlayerState): void {
  playing = state.playing;
  if (!playing) {
    clearScopes();
    return;
  }
  showValue('bpm', state.tempo, true);
  showValue('speed', state.speed);
  if (state.order !== currentOrder) {
    currentOrder = state.order;
    selectListItem($('#orders'), currentOrder);
  }
  // While playing, the cursor rides on the playing row, so edit mode records there.
  if (!followSong) return;
  const changedPattern = state.pattern !== view.patternIndex;
  view.follow(state.pattern, state.row);
  if (changedPattern) {
    showValue('pattern-no', state.pattern);
    showValue('pattern-len', view.pattern.rows, true);
  }
}

/** Plays from the current order position; `row` starts there instead of at the top. */
async function play(loopPattern: boolean, row = 0): Promise<void> {
  const node = engine ?? (await ensureEngine());
  if (!node) return;
  node.send({ type: 'play', loopPattern, order: currentOrder, row });
  playing = true;
}

function stop(): void {
  engine?.send({ type: 'stop' });
  playing = false;
  clearScopes();
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
  muted = [];
  engine?.send({ type: 'mute', muted });
  editor.replaceSong(next);
  scheduleAutosave(true);
  sampleSlot = 0;
  view.moveTo(0, 0, Column.Note);
  showSong();
  setView('pattern');
  sampleEditor.resetView();
  renderEditors();
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

/** Puts a sample or XI instrument file into the current slot. */
async function importIntoSlot(file: File): Promise<void> {
  const index = instrument - 1;
  const slot = sampleSlot;
  try {
    const buffer = await file.arrayBuffer();
    let imported = importSample(buffer, file.name);
    if (!imported) {
      // MP3, OGG, FLAC and the rest: the browser decodes them, resampled to 44.1 kHz.
      const rate = 44100;
      const audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buffer);
      const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
      imported = { kind: 'sample', sample: sampleFromChannels(channels, rate, file.name), rate };
    }
    if (imported.kind === 'instrument') {
      const ins = imported.instrument;
      editor.replaceInstrument(index, 'load instrument', ins);
      status.textContent = `${file.name}: instrument with ${ins.samples.length} samples in ${hex(instrument)}.`;
    } else {
      const sample = imported.sample;
      editor.editInstrument(index, 'load sample', (ins) => {
        while (ins.samples.length < slot) ins.samples.push(emptySample());
        ins.samples[slot] = sample;
        if (!ins.name) ins.name = sample.name;
      });
      status.textContent = `${file.name}: ${sample.data.length} frames at ${imported.rate} Hz in ${hex(instrument)}/${hex(slot, 1)}.`;
    }
    sampleEditor.resetView();
    if (app.dataset.view === 'pattern') setView('sample');
  } catch (error) {
    status.textContent = `Could not load ${file.name}: ${(error as Error).message}`;
  }
}

function download(bytes: Uint8Array, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = (name: string, fallback: string) => (name.trim() || fallback).replace(/[^\w .-]+/g, '_');

function saveSample(): void {
  const s = song().instruments[instrument - 1]?.samples[sampleSlot];
  if (!s || s.data.length === 0) {
    status.textContent = 'This sample slot is empty.';
    return;
  }
  const name = safeName(s.name, `sample${hex(instrument)}-${hex(sampleSlot)}`);
  const rate = Math.round(rateForTuning(s.relativeNote, s.finetune));
  download(encodeWav([s.data], rate, 'pcm16'), `${name}.wav`, 'audio/wav');
  status.textContent = `Saved ${name}.wav at ${rate} Hz.`;
}

function saveInstrument(): void {
  const ins = song().instruments[instrument - 1];
  if (!ins) return;
  const name = safeName(ins.name, `instrument${hex(instrument)}`);
  download(saveXi(ins), `${name}.xi`, 'application/octet-stream');
  status.textContent = `Saved ${name}.xi.`;
}

function saveSong(): void {
  const s = song();
  const bytes = saveXm(s);
  const name = safeName(s.title, 'untitled');
  download(bytes, `${name}.xm`, 'audio/xm');
  editor.dirty = false;
  status.textContent = `Saved ${name}.xm (${bytes.length} bytes).`;
}

function saveSongAsMod(): void {
  const s = song();
  const { bytes, warnings } = saveMod(s);
  const name = safeName(s.title, 'untitled');
  download(bytes, `${name}.mod`, 'audio/mod');
  status.textContent = `Saved ${name}.mod (${bytes.length} bytes)${warnings.length ? `, ${warnings.length} things changed` : ''}.`;
  $('#save-info').textContent = warnings.length ? `MOD can't hold everything: ${warnings.join(' ')}` : 'Saved as MOD with nothing lost.';
}

// ---- Save dialog: XM, MOD, WAV export, autosaved versions ----------------

const fileDialog = $<HTMLDialogElement>('#file-dialog');
const exportGo = $<HTMLButtonElement>('#export-go');
const exportProgress = $<HTMLProgressElement>('#export-progress');
const exportInfo = $('#export-info');
let exporting: Worker | null = null;

function openFileDialog(): void {
  $('#save-info').textContent = '';
  void showAutosaves();
  fileDialog.showModal();
}

function exportWav(): void {
  if (exporting) {
    exporting.terminate();
    exportDone('Export cancelled.');
    return;
  }
  const s = song();
  const request: ExportRequest = {
    song: s,
    format: $<HTMLSelectElement>('#export-format').value as WavFormat,
    sampleRate: Number($<HTMLSelectElement>('#export-rate').value),
    stems: $<HTMLSelectElement>('#export-what').value === 'stems',
    muted: Array.from({ length: s.channels }, (_, c) => muted[c] === true),
    resampler: prefs.resampler,
    stereoSeparation: prefs.stereoSeparation,
    volumeRamps: prefs.volumeRamps,
    name: safeName(s.title, 'untitled'),
  };
  const worker = new Worker(new URL('./audio/export-worker.ts', import.meta.url), { type: 'module' });
  exporting = worker;
  exportGo.textContent = 'Cancel';
  exportProgress.hidden = false;
  exportProgress.value = 0;
  exportInfo.textContent = 'Rendering…';
  const started = performance.now();
  worker.onmessage = (event: MessageEvent<ExportReply>) => {
    const reply = event.data;
    if (reply.type === 'progress') {
      exportProgress.value = reply.fraction;
      return;
    }
    worker.terminate();
    if (reply.type === 'error') {
      exportDone(`Export failed: ${reply.message}`);
      return;
    }
    const zip = reply.fileName.endsWith('.zip');
    download(reply.bytes, reply.fileName, zip ? 'application/zip' : 'audio/wav');
    const took = ((performance.now() - started) / 1000).toFixed(1);
    exportDone(`${reply.fileName}: ${formatTime(reply.seconds)} of audio, ${(reply.bytes.length / 1e6).toFixed(1)} MB, rendered in ${took} s.`);
  };
  worker.onerror = (event) => {
    worker.terminate();
    exportDone(`Export failed: ${event.message}`);
  };
  worker.postMessage(request);
}

function exportDone(message: string): void {
  exporting = null;
  exportGo.textContent = 'Render';
  exportProgress.hidden = true;
  exportInfo.textContent = message;
  status.textContent = message;
}

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// ---- Autosave ------------------------------------------------------------

let autosaveTimer = 0;
let freshVersion = false;

/** Saves a few seconds after the last change; `fresh` starts a new version (new or loaded song). */
function scheduleAutosave(fresh = false): void {
  freshVersion ||= fresh;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => void autosaveNow(), 2000);
}

async function autosaveNow(): Promise<void> {
  const fresh = freshVersion;
  freshVersion = false;
  try {
    const s = song();
    await writeAutosave(s.title, saveXm(s), fresh, Date.now(), {
      format: s.format,
      formatName: s.formatName,
      channelPanning: [...s.channelPanning],
    });
  } catch {
    // Private windows and some browsers refuse IndexedDB; the tracker works without it.
  }
}

async function showAutosaves(): Promise<void> {
  const list = $('#autosave-list');
  let versions: Autosave[] = [];
  try {
    versions = await listAutosaves();
  } catch {
    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Not available in this browser.' }));
    return;
  }
  const items = versions.map((v) => {
    const li = document.createElement('li');
    const when = new Date(v.savedAt);
    const time = document.createElement('span');
    time.className = 'idx';
    time.textContent = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    li.append(time, ` ${v.title || 'untitled'}`);
    li.title = 'Open this version';
    li.addEventListener('click', () => {
      if (!confirmDiscard()) return;
      fileDialog.close();
      restoreAutosave(v);
    });
    return li;
  });
  if (!items.length) items.push(Object.assign(document.createElement('li'), { textContent: 'Nothing saved yet.' }));
  list.replaceChildren(...items);
}

function restoreAutosave(version: Autosave): void {
  try {
    startSong(applyOrigin(loadModule(version.bytes.slice().buffer, 'autosave.xm'), version.origin));
    status.textContent = `Restored ${version.title || 'untitled'} from ${new Date(version.savedAt).toLocaleString()}.`;
  } catch (error) {
    status.textContent = `Could not restore the autosave: ${(error as Error).message}`;
  }
}

/** On start, picks up where the last session left off. */
async function restoreLastSession(): Promise<void> {
  try {
    const [latest] = await listAutosaves();
    if (latest && !editor.dirty) {
      restoreAutosave(latest);
      // Keep editing this version rather than starting a new one.
      freshVersion = false;
      clearTimeout(autosaveTimer);
    }
  } catch {
    // No IndexedDB, start with a new song.
  }
}

$('#new').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  startSong(createSong());
  status.textContent = 'New song: 4 channels, five chip instruments.';
});
$('#load').addEventListener('click', () => fileInput.click());
$('#save').addEventListener('click', openFileDialog);
$('#save-xm').addEventListener('click', saveSong);
$('#save-mod').addEventListener('click', saveSongAsMod);
exportGo.addEventListener('click', exportWav);
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openModule(file);
  fileInput.value = '';
});
window.addEventListener('dragover', (event) => event.preventDefault());
const sampleInput = $<HTMLInputElement>('#sample-file');
sampleInput.addEventListener('change', () => {
  const file = sampleInput.files?.[0];
  if (file) void importIntoSlot(file);
  sampleInput.value = '';
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  if (/\.(mod|xm|stk)$/i.test(file.name)) void openModule(file);
  else void importIntoSlot(file);
});
window.addEventListener('beforeunload', (event) => {
  if (editor.dirty) event.preventDefault();
});

// ---- Buttons and layout --------------------------------------------------

$('#rec').addEventListener('click', () => setRecording(!recording));
$('#play-song').addEventListener('click', () => void play(false));
$('#play-pattern').addEventListener('click', () => void play(true));
$('#stop').addEventListener('click', stop);

// ---- Advanced Edit ---------------------------------------------------------

const editTools = $<HTMLDialogElement>('#edit-tools');
const editInfo = $('#edit-info');
const editRange = $<HTMLSelectElement>('#edit-range');
const hexField = (id: string) => parseInt($<HTMLInputElement>(id).value, 16);
const numberField = (id: string) => Number($<HTMLInputElement>(id).value);

function openEditTools(): void {
  editRange.value = view.selection ? 'selection' : 'track';
  $<HTMLOptionElement>('#edit-range option[value="selection"]').disabled = !view.selection;
  $<HTMLInputElement>('#rm-from').value = hex(instrument, 2);
  editInfo.textContent = 'Applies to the range above; Ctrl+Z undoes it.';
  editTools.showModal();
}

function runEditTool(label: string, tool: (pattern: Pattern, block: Block) => number, what: string): void {
  const changed = applyRange(editRange.value as EditRange, label, tool);
  const name = label[0]!.toUpperCase() + label.slice(1);
  editInfo.textContent = changed ? `${name}: ${changed} ${what} changed.` : `${name}: nothing to change.`;
  status.textContent = editInfo.textContent;
}

$('#edit-tools-open').addEventListener('click', openEditTools);
$('#tr-go').addEventListener('click', () => {
  const amount = Math.trunc(numberField('#tr-amount'));
  const ins = hexField('#tr-ins') || 0;
  if (!amount) return;
  runEditTool('transpose', (p, b) => transposeBlock(song(), p, b, amount, ins), 'notes');
});
$('#rm-go').addEventListener('click', () => {
  const from = hexField('#rm-from');
  const to = hexField('#rm-to');
  if (!(from >= 1 && from <= 128 && to >= 1 && to <= 128) || from === to) {
    editInfo.textContent = 'Instrument numbers are hex, 01 to 80.';
    return;
  }
  runEditTool('remap instrument', (p, b) => remapInstrument(song(), p, b, from, to), 'cells');
});
$('#sc-go').addEventListener('click', () => {
  const start = Math.max(0, numberField('#sc-start'));
  const end = Math.max(0, numberField('#sc-end'));
  runEditTool('scale volume', (p, b) => scaleVolumeBlock(song(), p, b, start, end), 'volumes');
});

const help = $<HTMLDialogElement>('#help');
$('#help-open').addEventListener('click', () => help.showModal());

// Buttons hand focus back to the pattern, so Space and Enter never press them twice.
document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('.btn');
  if (button && !(button.closest('dialog'))) patternEl.focus({ preventScroll: true });
});

// A phone on its side has little height, so it starts with the panels folded.
if (matchMedia('(max-height: 500px) and (orientation: landscape)').matches) app.dataset.tab = 'none';
for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab-target]')) {
  tab.setAttribute('aria-selected', String(tab.dataset.tabTarget === app.dataset.tab));
  tab.addEventListener('click', () => {
    // The open tab folds the panels away, leaving room for pattern and piano.
    const open = app.dataset.tab !== tab.dataset.tabTarget;
    app.dataset.tab = open ? tab.dataset.tabTarget! : 'none';
    for (const other of document.querySelectorAll('[data-tab-target]')) {
      other.setAttribute('aria-selected', String(open && other === tab));
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

const piano = mountPiano($('#piano'), {
  down: (note) => playNote(note),
  up: (note) => previewOff(note),
  // Swiping the piano also sets the octave for the computer keyboard, and back.
  scrolled: (octave) => setOctave(octave, false),
});
piano.showOctave(settings.octave);

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
    case 'KeyI':
      interpolateSelection();
      return true;
    case 'KeyE':
      openEditTools();
      return true;
    case 'KeyF':
      followSong = !followSong;
      status.textContent = followSong ? 'Follow song on.' : 'Follow song off: the cursor stays put while the song plays.';
      return true;
    case 'Enter':
    case 'NumpadEnter':
      // Ctrl+Enter plays the pattern from the cursor row, with Shift the song.
      void play(!event.shiftKey, view.row);
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
  if (document.querySelector('dialog[open]')) return;
  const target = event.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

  const inPattern = app.dataset.view === 'pattern';
  if (inPattern && blockKey(event)) {
    event.preventDefault();
    return;
  }
  const ctrlOctave = event.ctrlKey && !event.altKey && !event.shiftKey ? octaveForKey(event.code, settings.octave, true) : null;
  if (ctrlOctave !== null) {
    event.preventDefault();
    setOctave(ctrlOctave);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    // Outside the pattern only undo, redo, save and load apply.
    if (!inPattern && !['KeyZ', 'KeyY', 'KeyS', 'KeyO'].includes(event.code)) return;
    if (!event.altKey && handleCommand(event)) event.preventDefault();
    return;
  }
  if (!inPattern) {
    previewKeys(event);
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

  const newOctave = octaveForKey(event.code, settings.octave);
  if (newOctave !== null) {
    event.preventDefault();
    setOctave(newOctave);
    return;
  }

  const jump = JUMP_KEYS[event.code];
  if (jump !== undefined) {
    // F9–F12 jump to the start, a quarter, half and three quarters of the pattern.
    event.preventDefault();
    view.moveTo(Math.floor((view.pattern.rows * jump) / 4), view.channel, view.column, event.shiftKey);
    return;
  }
  if (event.shiftKey && (event.code === 'KeyM' || event.code === 'KeyU')) {
    event.preventDefault();
    const next = Array.from({ length: song().channels }, (_, k) => muted[k] === true);
    if (event.code === 'KeyM') next[view.channel] = !next[view.channel];
    setMuted(event.code === 'KeyM' ? next : []);
    return;
  }

  switch (event.code) {
    case 'Escape':
      view.setSelection(null);
      return;
    case 'Space':
      event.preventDefault();
      if (prefs.space === 'play' && !event.shiftKey) {
        if (playing) stop();
        else void play(false);
      } else if (playing && prefs.space === 'ft2') stop();
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

/** Outside the pattern editor the keys only play: notes, octave, Space and Enter. */
function previewKeys(event: KeyboardEvent): void {
  if (event.altKey || event.repeat) return;
  const newOctave = octaveForKey(event.code, settings.octave);
  if (newOctave !== null) {
    event.preventDefault();
    setOctave(newOctave);
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    if (playing) stop();
    else if (prefs.space === 'play') void play(false);
    return;
  }
  if (event.code === 'Enter') {
    event.preventDefault();
    void play(event.shiftKey);
    return;
  }
  const note = noteForKey(event.code, settings.octave);
  if (note === null) return;
  event.preventDefault();
  heldKeys.set(event.code, note);
  void previewOn(note);
  status.textContent = `${noteName(note)}  Instr ${hex(instrument)}`;
}

window.addEventListener('keyup', (event) => {
  const note = heldKeys.get(event.code);
  if (note === undefined) return;
  heldKeys.delete(event.code);
  previewOff(note);
});

view.onCursor = () => {
  status.textContent = `Row ${hex(view.row)}  Channel ${view.channel + 1}`;
};

// ---- Setup: colours, mixer, highlights, keys, MIDI -----------------------

const setup = $<HTMLDialogElement>('#setup');
const themeSelect = $<HTMLSelectElement>('#set-theme');
themeSelect.replaceChildren(
  ...Object.entries(THEMES).map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })),
);
const checkbox = (id: string) => $<HTMLInputElement>(id);

function mixerMessage(): EngineMessage {
  return { type: 'mixer', resampler: prefs.resampler, stereoSeparation: prefs.stereoSeparation, volumeRamps: prefs.volumeRamps };
}

function applySettings(): void {
  document.documentElement.dataset.theme = prefs.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--desk').trim());
  view.beat = prefs.beat;
  view.bar = prefs.bar;
  view.render();
  engine?.send(mixerMessage());
  scopesDirty = true;
  renderEditors();
  void connectMidi(prefs.midi);
}

function showSettings(): void {
  themeSelect.value = prefs.theme;
  $<HTMLSelectElement>('#set-resampler').value = prefs.resampler;
  $<HTMLInputElement>('#set-separation').value = String(prefs.stereoSeparation);
  $('#set-separation-value').textContent = `${prefs.stereoSeparation}%`;
  checkbox('#set-ramps').checked = prefs.volumeRamps;
  $<HTMLSelectElement>('#set-beat').value = String(prefs.beat);
  $<HTMLSelectElement>('#set-bar').value = String(prefs.bar);
  $<HTMLSelectElement>('#set-space').value = prefs.space;
  checkbox('#set-midi').checked = prefs.midi;
  checkbox('#set-velocity').checked = prefs.midiVelocity;
}

setup.addEventListener('change', () => {
  prefs.theme = themeSelect.value as Theme;
  prefs.resampler = $<HTMLSelectElement>('#set-resampler').value as Resampler;
  prefs.stereoSeparation = Number($<HTMLInputElement>('#set-separation').value);
  $('#set-separation-value').textContent = `${prefs.stereoSeparation}%`;
  prefs.volumeRamps = checkbox('#set-ramps').checked;
  prefs.beat = Number($<HTMLSelectElement>('#set-beat').value);
  prefs.bar = Number($<HTMLSelectElement>('#set-bar').value);
  prefs.space = $<HTMLSelectElement>('#set-space').value as Settings['space'];
  prefs.midi = checkbox('#set-midi').checked;
  prefs.midiVelocity = checkbox('#set-velocity').checked;
  saveSettings(prefs);
  applySettings();
});
$('#setup-open').addEventListener('click', () => {
  showSettings();
  setup.showModal();
});

// Web MIDI: note on plays and records like the keyboard, note off releases.
let midiAccess: MIDIAccess | null = null;

function onMidi(event: MIDIMessageEvent): void {
  const [status = 0, data1 = 0, data2 = 0] = event.data ?? [];
  const kind = status & 0xf0;
  const note = midiToNote(data1);
  if (note === null) return;
  if (kind === 0x90 && data2 > 0) playNote(note, prefs.midiVelocity ? velocityToVolume(data2) : 0);
  else if (kind === 0x80 || kind === 0x90) previewOff(note);
}

function listenToInputs(): void {
  midiAccess?.inputs.forEach((input) => (input.onmidimessage = prefs.midi ? onMidi : null));
}

async function connectMidi(on: boolean): Promise<void> {
  if (!on) {
    listenToInputs();
    return;
  }
  const info = $('#setup-info');
  if (!('requestMIDIAccess' in navigator)) {
    info.textContent = 'This browser has no Web MIDI.';
    return;
  }
  try {
    midiAccess ??= await navigator.requestMIDIAccess();
    midiAccess.onstatechange = listenToInputs;
    listenToInputs();
    const names = [...midiAccess.inputs.values()].map((i) => i.name ?? 'MIDI input');
    info.textContent = names.length ? `MIDI: ${names.join(', ')}` : 'MIDI is on; no input device connected yet.';
  } catch (error) {
    info.textContent = `MIDI not allowed: ${(error as Error).message}`;
  }
}

applySettings();
showSong();
void restoreLastSession();

// Offline use: the service worker exists only in the build.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Without it the tracker still works online.
  });
}
