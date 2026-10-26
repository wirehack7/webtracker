import '@fontsource/press-start-2p/400.css';
import './style.css';
import {
  blockBetween,
  clearBlock,
  copyBlock,
  createSong,
  deleteRow,
  emptyPattern,
  emptySample,
  LoopType,
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
  cleanupSong,
  type Block,
  type Cell,
  type CleanupResult,
  type Clip,
  type Pattern,
  type PlayerState,
  type Resampler,
  type Sample,
  type Song,
} from '@webtracker/engine';
import { applyTrack, encodeWav, importSample, loadModule, loadRaw, loadXp, loadXt, sampleFromChannels, save8svx, saveMod, saveXi, saveXm, saveXp, saveXt, type RawFormat } from '@webtracker/formats';
import { EngineNode } from './audio/engine.ts';
import type { ExportReply, ExportRequest } from './audio/export-worker.ts';
import { parseAudioFormat } from './audio/audio-format.ts';
import { canExportVideo, exportVideo } from './video/video-export.ts';
import type { VideoContainer } from './video/video-worker.ts';
import type { EngineMessage, WorkletMessage } from './audio/messages.ts';
import { enterEffect, enterInstrument, enterParam, enterVolume, nextAfterPadKey } from './editor/entry.ts';
import { freePattern, patternInfos } from './editor/patterns.ts';
import { SongEditor, type SongDocument } from './editor/song-editor.ts';
import { answerInvite, createInvite, JAM_PARAM, JAM_TAB_PARAM, jamFromHash, joinInTab, listenInTabs, newRoom, TRANSFER_PARAM, transferFromHash, type Invite } from './collab/links.ts';
import { JamSession, type JamDocument, type Link } from './collab/session.ts';
import { noteForKey, octaveForKey } from './keyboard.ts';
import { ask, askText, tell } from './ui/ask.ts';
import { relaxFileFilters } from './ui/platform.ts';
import { padKeys, renderPadKeys } from './ui/entry-pad.ts';
import { cellHelpTarget } from './ui/help-content.ts';
import { mountAbout } from './ui/about.ts';
import { mountHelp } from './ui/help.ts';
import { hasVisitedBefore, markSeen, mountWhatsNew, readSeen, shouldShow } from './ui/changelog.ts';
import { mountSongStats } from './ui/song-stats.ts';
import { InstrumentEditor } from './ui/instrument-editor.ts';
import { PatternEditor } from './ui/pattern-editor.ts';
import { Column, formatEffect, formatVolume, hex } from './ui/pattern-view.ts';
import { mountPiano } from './ui/piano.ts';
import { SampleEditor } from './ui/sample-editor.ts';
import { mountSampleLibrary } from './ui/sample-library.ts';
import { BLOCKED } from './storage/db.ts';
import { applyOrigin, listAutosaves, originOf, writeAutosave, type Autosave } from './storage/autosave.ts';
import { createBackup, isSettingsKey, planRestore, readBackup } from './storage/backup.ts';
import { addSongs, deleteSong, listSongs, putSong, renameSong, type LibrarySong } from './storage/library.ts';
import { decodeShare, encodeShare, replayerUrl, SHARE_PARAM, shareFromHash, shrinkSong, type ShareQuality } from './storage/share.ts';
import { track } from './track.ts';
import { initLanguage, language, LANGUAGES, msg, t, tNodes, translatePage } from './i18n/i18n.ts';
import { editName } from './i18n/edit-names.ts';
import { COLOR_VARS, loadSettings, midiToNote, parseColors, saveSettings, THEMES, UI_SIZES, uiPixel, velocityToVolume, type Settings, type Theme, type UiSize } from './ui/settings.ts';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

/** Browser preferences from the Setup dialog. */
const prefs: Settings = loadSettings();
// Read before anything is stored, so a first visit is told from a return.
const returning = (() => {
  try {
    return hasVisitedBefore(localStorage);
  } catch {
    return false;
  }
})();
// The language pack loads before anything below writes text.
await initLanguage(prefs.language);
translatePage();

const app = $<HTMLDivElement>('#app');
const insPicker = $<HTMLDialogElement>('#ins-picker');
const patPicker = $<HTMLDialogElement>('#pat-picker');
const status = $<HTMLSpanElement>('#status');
const patternEl = $<HTMLDivElement>('#pattern');
const view = new PatternEditor(patternEl);

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

view.neighbours = () => {
  const { orders, patterns } = song();
  const at = (order: number) => (order >= 0 && order < orders.length ? (patterns[orders[order]!] ?? null) : null);
  return [at(currentOrder - 1), at(currentOrder + 1)];
};

const host = {
  editor,
  instrumentIndex: () => instrument - 1,
  sampleIndex: () => sampleSlot,
  status: (text: string) => (status.textContent = text),
  importFile: () => $<HTMLInputElement>('#sample-file').click(),
  openLibrary: () => sampleLibrary.open(),
  saveInstrument: () => saveInstrument(),
  saveSample: (format: 'wav' | 'iff') => saveSample(format),
};
const sampleEditor = new SampleEditor(host);
const instrumentEditor = new InstrumentEditor(host);
$('#editors').append(sampleEditor.root, instrumentEditor.root);

/** Starts audio on the first key or tap, browsers only allow it from a gesture. */
function ensureEngine(): Promise<EngineNode | null> {
  // Audio may start on a tap that also loads a file; that file's message stays.
  const before = status.textContent;
  starting ??= EngineNode.start().then(
    (node) => {
      engine = node;
      node.onMessage = handleWorkletMessage;
      node.send({ type: 'load', song: editor.song });
      node.send({ type: 'mute', muted });
      node.send(mixerMessage());
      if (status.textContent === before) status.textContent = t('Audio running at {rate} Hz.', { rate: node.context.sampleRate });
      return node;
    },
    (error: unknown) => {
      starting = null;
      status.textContent = t('Audio could not start: {error}', { error: String(error) });
      return null;
    },
  );
  return starting;
}
// iOS starts audio only when a tap ends, so the press of a piano key cannot start it in time.
// Starting it on the first finished tap or key anywhere lets that first key sound.
for (const type of ['touchend', 'click', 'keydown'] as const) {
  window.addEventListener(type, () => void ensureEngine(), { once: true, capture: true, passive: true });
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
  status.textContent = t('{note}  Instr {instrument}  Channel {channel}', { note: noteName(note), instrument: hex(instrument), channel: view.channel + 1 });
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
  const change = columnChange(key);
  if (!change) return false;
  editCell('entry', change);
  advance();
  return true;
}

/** What typing `key` at the cursor changes in the cell, if the column takes it. */
function columnChange(key: string): Partial<Cell> | null {
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
  return change;
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
const BLOCK_MESSAGES = {
  cut: {
    block: msg('Cut block: {rows} rows × {channels} channels.'),
    track: msg('Cut track: {rows} rows × {channels} channels.'),
    pattern: msg('Cut pattern: {rows} rows × {channels} channels.'),
  },
  copy: {
    block: msg('Copied block: {rows} rows × {channels} channels.'),
    track: msg('Copied track: {rows} rows × {channels} channels.'),
    pattern: msg('Copied pattern: {rows} rows × {channels} channels.'),
  },
};
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
  status.textContent = t(BLOCK_MESSAGES[action === 'cut' ? 'cut' : 'copy'][scope], { rows: clipboard.rows, channels: clipboard.channels });
  return true;
}

function copySelection(cut: boolean): void {
  const block = view.blockOrCursor();
  clipboard = copyBlock(song(), view.pattern, block);
  if (cut) editor.editPattern(view.patternIndex, 'cut', (p) => clearBlock(song(), p, block));
  const size = { rows: clipboard.rows, channels: clipboard.channels };
  status.textContent = cut ? t('Cut {rows} rows × {channels} channels.', size) : t('Copied {rows} rows × {channels} channels.', size);
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
    status.textContent = t('Select at least three rows to interpolate.');
    return;
  }
  const column = view.column >= Column.Effect ? 'effect' : 'volume';
  let changed = 0;
  editor.editPattern(view.patternIndex, 'interpolate', (p) => {
    changed = interpolateBlock(song(), p, block, column);
  });
  if (column === 'effect') {
    status.textContent = changed
      ? t('Interpolated {count} effect values.', { count: changed })
      : t('Nothing to interpolate: the first and last row need the same kind of effect.');
  } else {
    status.textContent = changed
      ? t('Interpolated {count} volumes.', { count: changed })
      : t('Nothing to interpolate: the first and last row need the same kind of volume command.');
  }
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
  if (patPicker.open) fillPatternPicker();
}

function instrumentCount(): number {
  return Math.max(128, song().instruments.length);
}

function fillInstruments(): void {
  const s = song();
  fillList($('#instrument-list'), instrumentCount(), 1, (i) => s.instruments[i - 1]?.name ?? '', instrument);
  fillSampleList();
  showQuickInstrument();
  if (insPicker.open) fillPicker();
}

/** The phone-only instrument button above the editor. */
function showQuickInstrument(): void {
  $('#ins-pick-no').textContent = hex(instrument);
  $('#ins-pick-name').textContent = song().instruments[instrument - 1]?.name ?? '';
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
  const text = decimal ? String(value) : hex(value);
  $<HTMLOutputElement>(`#${id}`).textContent = text;
  // Phones show the pattern length in the menu sheet instead.
  if (id === 'pattern-len') $('#len-proxy').textContent = text;
  if (id === 'add') $('#pad-step span').textContent = String(value);
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
  blankTab = false;
  renderTabs();
  if (label === 'channels') {
    // The worklet rebuilt its player for the new layout, so playback has stopped.
    stop();
    muted = muted.slice(0, song().channels);
    engine?.send({ type: 'mute', muted });
    showSong();
    view.moveTo(view.row, Math.min(view.channel, song().channels - 1));
    return;
  }
  if (label === 'clean up') {
    // Like a channel change, the cleanup reloads the song in the worklet.
    stop();
    instrument = Math.max(1, Math.min(instrument, song().instruments.length));
    showSong();
    return;
  }
  if (label === 'title') {
    titleInput.value = song().title;
    return;
  }
  if (label === 'jam') {
    // Someone else in the jam changed the song: anything may have moved.
    const s = song();
    showValue('bpm', s.initialTempo, true);
    showValue('speed', s.initialSpeed);
    if (document.activeElement !== titleInput) titleInput.value = s.title;
    fillOrders();
    fillInstruments();
    showPosition();
    renderEditors();
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

function selectInstrument(index: number): void {
  instrument = index;
  sampleSlot = 0;
  selectListItem($('#instrument-list'), instrument);
  fillSampleList();
  showQuickInstrument();
  sampleEditor.resetView();
  renderEditors();
}

function selectSample(slot: number): void {
  sampleSlot = slot;
  selectListItem($('#sample-list'), sampleSlot);
  sampleEditor.resetView();
  renderEditors();
}

$('#instrument-list').addEventListener('select', (event) => selectInstrument((event as CustomEvent<number>).detail));
$('#sample-list').addEventListener('select', (event) => selectSample((event as CustomEvent<number>).detail));

// Phones: step through instruments or pick one without opening the menu sheet.
function fillPicker(): void {
  const s = song();
  const list = $('#picker-list');
  fillList(list, instrumentCount(), 1, (i) => s.instruments[i - 1]?.name ?? '', instrument);
  for (const li of list.children) {
    const ins = s.instruments[Number((li as HTMLElement).dataset.index) - 1];
    li.classList.toggle('empty', !ins?.samples.some((sample) => sample.data.length > 0));
  }
  // Only instruments with several samples need a choice of sample.
  const samples = s.instruments[instrument - 1]?.samples ?? [];
  const buttons = samples.map((sample, slot) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.dataset.slot = String(slot);
    b.setAttribute('aria-pressed', String(slot === sampleSlot));
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = hex(slot, 1);
    b.append(idx, ` ${sample.name}`);
    return b;
  });
  $('#picker-samples').replaceChildren(...buttons);
  insPicker.classList.toggle('one-sample', samples.length <= 1);
}

$('#ins-pick').addEventListener('click', () => {
  fillPicker();
  insPicker.showModal();
  $('#picker-list').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
});
$('#picker-list').addEventListener('select', (event) => {
  selectInstrument((event as CustomEvent<number>).detail);
  insPicker.close();
});
$('#picker-samples').addEventListener('click', (event) => {
  const b = (event.target as HTMLElement).closest<HTMLElement>('[data-slot]');
  if (!b) return;
  selectSample(Number(b.dataset.slot));
  insPicker.close();
});
// A tap on the backdrop closes the picker.
insPicker.addEventListener('click', (event) => {
  const r = insPicker.getBoundingClientRect();
  const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
  if (event.target === insPicker && !inside) insPicker.close();
});
// The built-in sample library, from the sample and instrument editors and the phone picker.
/** The sound the library is playing, stopped when the next one starts. */
let audition: AudioBufferSourceNode | null = null;
async function auditionSample(sample: Sample): Promise<void> {
  const node = engine ?? (await ensureEngine());
  if (!node || sample.data.length === 0) return;
  audition?.stop();
  const ctx = node.context;
  // C-4 plays a sample at this rate; the browser resamples it to the output.
  const rate = Math.max(3000, Math.min(384000, rateForTuning(sample.relativeNote, sample.finetune)));
  const buffer = ctx.createBuffer(1, sample.data.length, rate);
  buffer.getChannelData(0).set(sample.data);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  const level = (0.5 * sample.volume) / 64;
  gain.gain.value = level;
  if (sample.loopType !== LoopType.None && sample.loopLength > 0) {
    // A looped wave would ring forever: let it sound for a moment and fade.
    source.loop = true;
    source.loopStart = sample.loopStart / rate;
    source.loopEnd = (sample.loopStart + sample.loopLength) / rate;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(level, now + 0.5);
    gain.gain.linearRampToValueAtTime(0, now + 0.6);
  }
  source.connect(gain).connect(ctx.destination);
  source.start();
  if (source.loop) source.stop(ctx.currentTime + 0.6);
  audition = source;
}

const sampleLibraryDialog = $<HTMLDialogElement>('#sample-library');
const sampleLibrary = mountSampleLibrary(sampleLibraryDialog, {
  audition: (sample) => void auditionSample(sample),
  loadSample(sample) {
    const slot = sampleSlot;
    editor.editInstrument(instrument - 1, 'load sample', (ins) => {
      while (ins.samples.length < slot) ins.samples.push(emptySample());
      ins.samples[slot] = sample;
      if (!ins.name) ins.name = sample.name;
    });
    sampleEditor.resetView();
    status.textContent = t('{name} from the sample library in {slot}.', { name: sample.name, slot: `${hex(instrument)}/${hex(slot, 1)}` });
  },
  loadInstrument(ins) {
    editor.replaceInstrument(instrument - 1, 'load instrument', ins);
    selectSample(0);
    status.textContent = t('{name} from the sample library is instrument {instrument}.', { name: ins.name, instrument: hex(instrument) });
  },
});
sampleLibraryDialog.addEventListener('close', () => {
  audition?.stop();
  audition = null;
});
$('#picker-library').addEventListener('click', () => {
  insPicker.close();
  sampleLibrary.open();
});

/** The arrows stop one slot after the last instrument with samples, ready for a new one. */
function stepInstrument(delta: number): void {
  const instruments = song().instruments;
  let used = instruments.length;
  while (used > 0 && !instruments[used - 1]!.samples.some((sample) => sample.data.length > 0)) used--;
  const last = Math.min(instrumentCount(), Math.max(used + 1, instrument));
  const next = Math.max(1, Math.min(last, instrument + delta));
  if (next !== instrument) selectInstrument(next);
}
$('#ins-prev').addEventListener('click', () => stepInstrument(-1));
$('#ins-next').addEventListener('click', () => stepInstrument(1));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view-target]')) {
  b.addEventListener('click', () => setView(b.dataset.viewTarget!));
}
function goToOrder(order: number): void {
  currentOrder = order;
  if (playing) engine?.send({ type: 'seek', order: currentOrder });
  showPosition();
}
$('#orders').addEventListener('select', (event) => goToOrder((event as CustomEvent<number>).detail));

// The pattern number opens a list of all patterns for the current position.
function fillPatternPicker(): void {
  const s = song();
  const infos = patternInfos(s);
  const list = $('#pat-list');
  fillList(list, infos.length, 0, () => '', currentPatternIndex());
  for (const li of list.children) {
    const info = infos[Number((li as HTMLElement).dataset.index)]!;
    const rows = document.createElement('span');
    rows.className = 'rows';
    rows.textContent = `${t('{rows} rows', { rows: String(info.rows).padStart(3, '0') })} `;
    const at = info.positions.length ? `@ ${info.positions.map((p) => hex(p)).join(' ')}` : t('unused');
    li.append(rows, at);
    li.classList.toggle('empty', info.empty);
  }
  $('#pat-pos').textContent = hex(currentOrder);
  $('#pat-pos-count').textContent = hex(s.orders.length);
  $<HTMLButtonElement>('#pat-pos-prev').disabled = currentOrder <= 0;
  $<HTMLButtonElement>('#pat-pos-next').disabled = currentOrder >= s.orders.length - 1;
  const full = freePattern(s) === null;
  $<HTMLButtonElement>('#pat-new').disabled = full;
  $<HTMLButtonElement>('#pat-clone').disabled = full;
}

$('#pat-pick').addEventListener('click', () => {
  fillPatternPicker();
  patPicker.showModal();
  $('#pat-list').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
});
$('#pat-list').addEventListener('select', (event) => {
  const next = (event as CustomEvent<number>).detail;
  const at = currentOrder;
  editor.editOrders('pattern number', (o) => o.map((p, i) => (i === at ? next : p)));
  patPicker.close();
});
for (const [id, delta] of [['#pat-pos-prev', -1], ['#pat-pos-next', 1]] as const) {
  $(id).addEventListener('click', () => {
    goToOrder(Math.max(0, Math.min(song().orders.length - 1, currentOrder + delta)));
    fillOrders();
  });
}
for (const [id, clone] of [['#pat-new', false], ['#pat-clone', true]] as const) {
  $(id).addEventListener('click', () => {
    const s = song();
    const index = freePattern(s);
    if (index === null) return;
    const source = s.patterns[currentPatternIndex()] ?? emptyPattern(64, s.channels);
    const pattern = clone ? source : emptyPattern(source.rows, s.channels);
    editor.placePattern(currentOrder, index, pattern, clone ? 'clone pattern' : 'new pattern');
    patPicker.close();
  });
}
patPicker.addEventListener('click', (event) => {
  const r = patPicker.getBoundingClientRect();
  const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
  if (event.target === patPicker && !inside) patPicker.close();
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
    const apply = () => {
      editor.setChannels(channels);
      status.textContent = t('{count} channels.', { count: channels });
    };
    if (channels >= s.channels) apply();
    else {
      const message =
        channels + 1 === s.channels
          ? t('Remove channel {channel} from every pattern? Undo brings it back.', { channel: s.channels })
          : t('Remove channels {first}–{last} from every pattern? Undo brings them back.', { first: channels + 1, last: s.channels });
      void ask(message, { title: t('Channels'), ok: t('Remove') }).then((ok) => ok && apply());
    }
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
  $('#bar-octave').textContent = t('Oct {octave}', { octave });
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
    box.title = t('Click: mute, right-click: solo');
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
  status.textContent = off ? t('Muted: {channels}', { channels: muted.flatMap((m, c) => (m ? [c + 1] : [])).join(' ') }) : t('All channels on.');
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

/** The phone bar has one Play button that turns into Stop. */
function showPlaying(on: boolean): void {
  playing = on;
  const button = $('#bar-play');
  button.textContent = on ? t('Stop') : t('Play');
  button.setAttribute('aria-pressed', String(on));
}

function showPlayerState(state: PlayerState): void {
  showPlaying(state.playing);
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
  showPlaying(true);
  // Once per visit is enough to tell that music was made or heard.
  if (!trackedPlay) track('play');
  trackedPlay = true;
}
let trackedPlay = false;

/** Plays just the cursor row, then moves the cursor down, to step through a pattern by ear. */
async function playRow(): Promise<void> {
  if (playing) stop();
  const node = engine ?? (await ensureEngine());
  if (!node) return;
  node.send({ type: 'playRow', order: currentOrder, row: view.row });
  view.moveTo(view.row + 1, view.channel, view.column);
}

function stop(): void {
  engine?.send({ type: 'stop' });
  showPlaying(false);
  clearScopes();
  showValue('bpm', song().initialTempo, true);
  showValue('speed', song().initialSpeed);
}

function setRecording(on: boolean): void {
  recording = on;
  $('#rec').setAttribute('aria-pressed', String(on));
  $('#bar-rec').setAttribute('aria-pressed', String(on));
  patternEl.classList.toggle('rec', on);
  showEntryPad();
}

// ---- Touch entry -----------------------------------------------------------
// In edit mode with the on-screen piano, a pad below the pattern shows the
// cursor cell in big fields. Outside the note column a keypad takes the
// piano's place and fills a field digit by digit, then steps down.

const entryPad = $('#entry-pad');
const entryKeys = $('#entry-keys');
let entryKeysFor = '';

function showEntryPad(): void {
  const on = recording && keysToggle.getAttribute('aria-pressed') === 'true';
  app.classList.toggle('touch-entry', on);
  app.classList.toggle('value-entry', on && view.column !== Column.Note);
  if (on) drawEntryPad();
}

function drawEntryPad(): void {
  const cell = cursorCell();
  const fx = formatEffect(cell.effect, cell.param);
  const texts = [
    cell.note ? noteName(cell.note) : '---',
    cell.instrument ? hex(cell.instrument) : '..',
    formatVolume(cell.volume),
    fx.slice(0, 1),
    fx.slice(1),
  ];
  const fields = entryPad.querySelectorAll<HTMLElement>('[data-field]');
  // The field the cursor is in: note, instrument, volume, effect or parameter.
  const at = [Column.Note, Column.InsLo, Column.VolLo, Column.Effect, Column.ParamLo].findIndex((last) => view.column <= last);
  fields.forEach((field, i) => {
    field.querySelector('span')!.textContent = texts[i]!;
    field.setAttribute('aria-pressed', String(i === at));
  });
  fields[0]!.querySelector('small')!.textContent = t('Ch {channel}', { channel: view.channel + 1 });
  app.classList.toggle('value-entry', view.column !== Column.Note);
  const keysFor = `${view.column}:${cell.effect}`;
  if (view.column !== Column.Note && keysFor !== entryKeysFor) {
    renderPadKeys(entryKeys, padKeys(view.column, cell.effect));
  }
  entryKeysFor = view.column === Column.Note ? '' : keysFor;
}

view.onDraw = () => {
  if (app.classList.contains('touch-entry')) drawEntryPad();
};

entryPad.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-field], [data-pad]');
  if (!button) return;
  if (button.dataset.field) {
    view.moveTo(view.row, view.channel, Number(button.dataset.field));
    return;
  }
  switch (button.dataset.pad) {
    case 'up':
      view.moveTo(view.row - 1, view.channel);
      break;
    case 'down':
      view.moveTo(view.row + 1, view.channel);
      break;
    case 'left':
      view.moveTo(view.row, view.channel - 1);
      break;
    case 'right':
      view.moveTo(view.row, view.channel + 1);
      break;
    case 'off':
      editCell('key off', { note: NOTE_KEY_OFF, instrument: 0 });
      advance();
      break;
    case 'clear':
      clearAtCursor();
      break;
    case 'undo': {
      const label = editor.undo();
      status.textContent = label ? t('Undo: {edit}', { edit: editName(label) }) : t('Nothing to undo.');
      break;
    }
  }
});

entryKeys.addEventListener('click', (event) => {
  const key = (event.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
  if (key === undefined) return;
  const change = columnChange(key);
  if (!change) return;
  editCell('entry', change);
  const next = nextAfterPadKey(view.column);
  view.moveTo(next.advance ? view.row + Math.max(0, settings.add) : view.row, view.channel, next.column);
});

// ---- Files ---------------------------------------------------------------

const fileInput = $<HTMLInputElement>('#file');
relaxFileFilters();

/** Names that tell what a file is; the picker may offer any file on phones, see relaxFileFilters. */
const MODULE_NAME = /\.(mod|xm|s3m|it|mtm|669|okt|stk|zip|gz|mdz|xmz|s3z|itz|mdgz|xmgz|s3gz|itgz|umx)$/i;
const PATTERN_NAME = /\.x[pt]$/i;
const SAMPLE_NAME = /\.(wav|aif|aiff|aifc|8svx|iff|xi|pat|flac|mp3|ogg|opus|m4a|aac)$/i;

/** Shows why a file did not open; a dialog, since phones hide the status bar. */
function loadFailed(file: File, error: unknown): void {
  const message = (error as Error).message;
  status.textContent = t('Could not load {file}: {error}', { file: file.name, error: message });
  void tell(t('{file} could not be opened: {error}', { file: file.name, error: message }), t('Load'));
}

async function confirmDiscard(): Promise<boolean> {
  // With tabs the next song gets its own, so nothing is discarded.
  return opensNewTab() || !editor.dirty || ask(t('Discard the changes to the current song?'), { title: t('Unsaved changes'), ok: t('Discard') });
}

function startSong(next: Song): void {
  // The jam is about the song in the editor; another one there ends it, except the jam's own song arriving.
  if (!adoptingJamSong) leaveJam(t('You left the jam to open another song. The jam song stays as it was.'));
  stop();
  if (opensNewTab()) {
    tabs[activeTab] = parkTab();
    activeTab = tabs.length;
    tabs.push(parkTab());
  }
  currentOrder = 0;
  muted = [];
  engine?.send({ type: 'mute', muted });
  editor.replaceSong(next);
  blankTab = false;
  scheduleAutosave(true);
  libraryEntry = null;
  sampleSlot = 0;
  view.moveTo(0, 0, Column.Note);
  showSong();
  setView('pattern');
  sampleEditor.resetView();
  renderEditors();
  renderTabs();
}

// ---- Song tabs -------------------------------------------------------------

/** A song that is open but not in the editor, with where the editor was in it. */
interface Tab {
  doc: SongDocument;
  order: number;
  row: number;
  channel: number;
  instrument: number;
  sampleSlot: number;
  library: { id: number; name: string } | null;
}

const tabBar = $('#song-tabs');
/** Every open song; the entry at `activeTab` is stale while that song is in the editor. */
let tabs: Tab[] = [];
let activeTab = 0;
/** True while the editor holds an untouched new song, which the next song may replace. */
let blankTab = true;

function opensNewTab(): boolean {
  return prefs.songTabs && !blankTab;
}

function parkTab(): Tab {
  return { doc: editor.detach(), order: currentOrder, row: view.row, channel: view.channel, instrument, sampleSlot, library: libraryEntry };
}

function showTab(index: number): void {
  stop();
  activeTab = index;
  const tab = tabs[index]!;
  editor.attach(tab.doc);
  blankTab = false;
  currentOrder = tab.order;
  instrument = tab.instrument;
  sampleSlot = tab.sampleSlot;
  libraryEntry = tab.library;
  muted = [];
  engine?.send({ type: 'mute', muted });
  // Autosave keeps a version per song, so the next save must not overwrite the other song's.
  freshVersion = true;
  showSong();
  view.moveTo(tab.row, Math.min(tab.channel, song().channels - 1), Column.Note);
  sampleEditor.resetView();
  renderEditors();
  renderTabs();
}

async function switchTab(index: number): Promise<void> {
  if (index === activeTab || !tabs[index]) return;
  if (jam?.active && !(await ask(t('Switching songs leaves the jam. Go on?'), { title: t('Jam'), ok: t('Switch') }))) return;
  leaveJam(t('You left the jam to switch songs. The jam song stays as it was.'));
  tabs[activeTab] = parkTab();
  showTab(index);
  status.textContent = t('Song {index} of {count}: {name}.', { index: index + 1, count: tabs.length, name: tabName(song(), libraryEntry) });
}

async function closeTab(index: number): Promise<void> {
  if (index !== activeTab) {
    const tab = tabs[index]!;
    if (tab.doc.dirty && !(await ask(t('Close "{name}" and discard its changes?', { name: tabName(tab.doc.song, tab.library) }), { title: t('Unsaved changes'), ok: t('Close') }))) return;
    // The list may have changed while the question was open.
    index = tabs.indexOf(tab);
    if (index < 0 || index === activeTab) return;
    tabs.splice(index, 1);
    if (index < activeTab) activeTab--;
    renderTabs();
    return;
  }
  if (editor.dirty && !(await ask(t('Close this song and discard its changes?'), { title: t('Unsaved changes'), ok: t('Close') }))) return;
  if (index !== activeTab) return;
  leaveJam(t('You left the jam by closing its song.'));
  tabs.splice(index, 1);
  if (tabs.length === 0) {
    // The last song makes way for a new one.
    activeTab = 0;
    blankTab = true;
    startSong(createSong());
    blankTab = true;
    return;
  }
  showTab(Math.min(index, tabs.length - 1));
}

function tabName(s: Song, library: Tab['library']): string {
  return s.title.trim() || library?.name || t('untitled');
}

/** The tab strip only shows while more than one song is open. */
function renderTabs(): void {
  if (tabs.length === 0) tabs = [parkTab()];
  tabBar.hidden = tabs.length < 2;
  if (tabBar.hidden) return;
  const buttons = tabs.map((tab, i) => {
    const active = i === activeTab;
    const s = active ? song() : tab.doc.song;
    const dirty = active ? editor.dirty : tab.doc.dirty;
    const item = document.createElement('span');
    item.className = 'song-tab';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'btn sm';
    pick.setAttribute('role', 'tab');
    pick.setAttribute('aria-selected', String(active));
    pick.textContent = `${tabName(s, active ? libraryEntry : tab.library)}${dirty ? '*' : ''}`;
    pick.title = t('Song {index} (Alt+PageUp/PageDown switch songs)', { index: i + 1 });
    pick.addEventListener('click', () => void switchTab(i));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn sm';
    close.textContent = 'x';
    close.title = t('Close this song');
    close.setAttribute('aria-label', t('Close {name}', { name: pick.textContent }));
    close.addEventListener('click', () => void closeTab(i));
    item.append(pick, close);
    return item;
  });
  tabBar.replaceChildren(...buttons);
}

async function openModule(file: File): Promise<void> {
  if (!(await confirmDiscard())) return;
  try {
    const loaded = loadModule(await file.arrayBuffer(), file.name);
    startSong(loaded);
    status.textContent = t('{file}: {title}, {format}, {channels} channels.', { file: file.name, title: loaded.title || t('untitled'), format: loaded.formatName, channels: loaded.channels });
    track('open-module', { format: loaded.formatName });
  } catch (error) {
    loadFailed(file, error);
  }
}

/** Headerless sample files; anything else that nothing can decode is read as raw too. */
const RAW_NAME = /\.(raw|smp|sam|pcm|bin)$/i;
const RAW_LABELS: Record<RawFormat, string> = { s8: msg('8-bit signed'), u8: msg('8-bit unsigned'), s16le: msg('16-bit little endian'), s16be: msg('16-bit big endian') };

/** Puts a sample or XI instrument file into the current slot. */
async function importIntoSlot(file: File): Promise<void> {
  const index = instrument - 1;
  const slot = sampleSlot;
  try {
    const buffer = await file.arrayBuffer();
    let imported = importSample(buffer, file.name);
    let raw = false;
    if (!imported && RAW_NAME.test(file.name)) {
      imported = loadRaw(buffer, file.name, prefs.rawFormat);
      raw = true;
    }
    if (!imported) {
      // MP3, OGG, FLAC and the rest: the browser decodes them, resampled to 44.1 kHz.
      const rate = 44100;
      try {
        const audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buffer.slice(0));
        const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
        imported = { kind: 'sample', sample: sampleFromChannels(channels, rate, file.name), rate };
      } catch {
        // Nothing the browser knows either: take the bytes as raw PCM, as trackers do.
        imported = loadRaw(buffer, file.name, prefs.rawFormat);
        raw = true;
      }
    }
    if (imported.kind === 'instrument') {
      const ins = imported.instrument;
      editor.replaceInstrument(index, 'load instrument', ins);
      status.textContent = t('{file}: instrument with {samples} samples in {instrument}.', { file: file.name, samples: ins.samples.length, instrument: hex(instrument) });
    } else {
      const sample = imported.sample;
      editor.editInstrument(index, 'load sample', (ins) => {
        while (ins.samples.length < slot) ins.samples.push(emptySample());
        ins.samples[slot] = sample;
        if (!ins.name) ins.name = sample.name;
      });
      const where = { file: file.name, frames: sample.data.length, rate: imported.rate, slot: `${hex(instrument)}/${hex(slot, 1)}` };
      status.textContent = raw
        ? t('{file}: {frames} frames at {rate} Hz in {slot}, read as raw {format} (Setup changes the format).', { ...where, format: t(RAW_LABELS[prefs.rawFormat]) })
        : t('{file}: {frames} frames at {rate} Hz in {slot}.', where);
    }
    sampleEditor.resetView();
    if (app.dataset.view === 'pattern') setView('sample');
  } catch (error) {
    loadFailed(file, error);
  }
}

function download(bytes: Uint8Array, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  // Safari and some phone browsers only follow a link that is in the page.
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Phones may start reading the file long after the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const safeName = (name: string, fallback: string) => (name.trim() || fallback).replace(/[^\w .-]+/g, '_');

function saveSample(format: 'wav' | 'iff'): void {
  const s = song().instruments[instrument - 1]?.samples[sampleSlot];
  if (!s || s.data.length === 0) {
    status.textContent = t('This sample slot is empty.');
    return;
  }
  const name = safeName(s.name, `sample${hex(instrument)}-${hex(sampleSlot)}`);
  const rate = Math.round(rateForTuning(s.relativeNote, s.finetune));
  if (format === 'iff') {
    download(save8svx(s, rate), `${name}.8svx`, 'audio/x-8svx');
    status.textContent = t('Saved {file} (8-bit) at {rate} Hz.', { file: `${name}.8svx`, rate });
    return;
  }
  download(encodeWav([s.data], rate, 'pcm16'), `${name}.wav`, 'audio/wav');
  status.textContent = t('Saved {file} at {rate} Hz.', { file: `${name}.wav`, rate });
}

function saveInstrument(): void {
  const ins = song().instruments[instrument - 1];
  if (!ins) return;
  const name = safeName(ins.name, `instrument${hex(instrument)}`);
  download(saveXi(ins), `${name}.xi`, 'application/octet-stream');
  status.textContent = t('Saved {file}.', { file: `${name}.xi` });
}

function saveSong(): void {
  const s = song();
  const bytes = saveXm(s);
  const name = safeName(s.title, 'untitled');
  download(bytes, `${name}.xm`, 'application/octet-stream');
  editor.dirty = false;
  renderTabs();
  status.textContent = t('Saved {file} ({bytes} bytes).', { file: `${name}.xm`, bytes: bytes.length });
  track('save-xm');
}

/** Browsers refuse longer addresses (Chrome stops at 2 MB). */
const MAX_REPLAYER_URL = 2_000_000;

/**
 * Opens the replayer page in a new tab with the song in its address. MOD
 * songs go as MOD when nothing is lost, so they keep ProTracker playback.
 */
async function openInReplayer(): Promise<void> {
  const info = $('#replayer-info');
  // Opened before the async packing, so popup blockers see the click.
  const tab = window.open('about:blank', '_blank');
  const s = song();
  const name = safeName(s.title, 'untitled');
  const mod = s.format === 'mod' ? saveMod(s) : null;
  const [bytes, fileName] = mod && mod.warnings.length === 0 ? [mod.bytes, `${name}.mod`] : [saveXm(s), `${name}.xm`];
  try {
    const url = await replayerUrl(location.href, bytes, fileName);
    if (url.length > MAX_REPLAYER_URL) {
      tab?.close();
      info.textContent = t('The song is too big to hand over. Save XM and load the file on the replayer page.');
      return;
    }
    if (!tab) {
      info.textContent = t('The browser blocked the new tab. Allow pop-ups for this site, or save the song and load it on the replayer page.');
      return;
    }
    tab.location.href = url;
    info.textContent = t('{file} opened in the replayer.', { file: fileName });
    track('open-in-replayer');
  } catch (error) {
    tab?.close();
    info.textContent = t('Could not open the replayer: {error}', { error: (error as Error).message });
  }
}

function saveSongAsMod(): void {
  const s = song();
  const { bytes, warnings } = saveMod(s);
  const name = safeName(s.title, 'untitled');
  download(bytes, `${name}.mod`, 'application/octet-stream');
  track('save-mod');
  const saved = { file: `${name}.mod`, bytes: bytes.length, changes: warnings.length };
  status.textContent = warnings.length ? t('Saved {file} ({bytes} bytes), {changes} things changed.', saved) : t('Saved {file} ({bytes} bytes).', saved);
  $('#save-info').textContent = warnings.length ? t("MOD can't hold everything: {warnings}", { warnings: warnings.join(' ') }) : t('Saved as MOD with nothing lost.');
}

// ---- Save dialog: XM, MOD, audio export, autosaved versions ----------------

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

const MIME_TYPES: Record<string, string> = { zip: 'application/zip', wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' };

function exportAudio(): void {
  if (exporting) {
    exporting.terminate();
    exportDone(t('Export cancelled.'));
    return;
  }
  const s = song();
  const request: ExportRequest = {
    song: s,
    format: parseAudioFormat($<HTMLSelectElement>('#export-format').value),
    sampleRate: Number($<HTMLSelectElement>('#export-rate').value),
    stems: $<HTMLSelectElement>('#export-what').value === 'stems',
    muted: Array.from({ length: s.channels }, (_, c) => muted[c] === true),
    resampler: prefs.resampler,
    stereoSeparation: prefs.stereoSeparation,
    volumeRamps: prefs.volumeRamps,
    amplify: prefs.amplify,
    karplusStrong: prefs.karplusStrong,
    name: safeName(s.title, 'untitled'),
  };
  const worker = new Worker(new URL('./audio/export-worker.ts', import.meta.url), { type: 'module' });
  exporting = worker;
  exportGo.textContent = t('Cancel');
  exportProgress.hidden = false;
  exportProgress.value = 0;
  exportInfo.textContent = t('Rendering…');
  const started = performance.now();
  worker.onmessage = (event: MessageEvent<ExportReply>) => {
    const reply = event.data;
    if (reply.type === 'progress') {
      exportProgress.value = reply.fraction;
      return;
    }
    worker.terminate();
    if (reply.type === 'error') {
      exportDone(t('Export failed: {error}', { error: reply.message }));
      return;
    }
    const extension = reply.fileName.slice(reply.fileName.lastIndexOf('.') + 1);
    download(reply.bytes, reply.fileName, MIME_TYPES[extension] ?? 'application/octet-stream');
    track('export-audio', { format: request.format.kind, stems: request.stems });
    const took = ((performance.now() - started) / 1000).toFixed(1);
    exportDone(
      t('{file}: {length} of audio, {size} MB, rendered in {took} s.', { file: reply.fileName, length: formatTime(reply.seconds), size: (reply.bytes.length / 1e6).toFixed(1), took }),
    );
  };
  worker.onerror = (event) => {
    worker.terminate();
    exportDone(t('Export failed: {error}', { error: event.message }));
  };
  worker.postMessage(request);
}

function exportDone(message: string): void {
  exporting = null;
  exportGo.textContent = t('Render');
  exportProgress.hidden = true;
  exportInfo.textContent = message;
  status.textContent = message;
}

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// ---- Video export ----------------------------------------------------------

const videoGo = $<HTMLButtonElement>('#video-go');
const videoProgress = $<HTMLProgressElement>('#video-progress');
const videoInfo = $('#video-info');
let videoExport: AbortController | null = null;

async function startVideoExport(): Promise<void> {
  if (videoExport) {
    videoExport.abort();
    return;
  }
  const s = song();
  const [width = 1280, height = 720] = $<HTMLSelectElement>('#video-size').value.split('x').map(Number);
  const controller = new AbortController();
  videoExport = controller;
  videoGo.textContent = t('Cancel');
  videoProgress.hidden = false;
  videoProgress.value = 0;
  videoInfo.textContent = t('Rendering…');
  const started = performance.now();
  try {
    const result = await exportVideo(
      {
        song: s,
        title: s.title.trim(),
        name: safeName(s.title, 'untitled'),
        width,
        height,
        fps: Number($<HTMLSelectElement>('#video-fps').value),
        container: $<HTMLSelectElement>('#video-format').value as VideoContainer,
        beat: prefs.beat,
        bar: prefs.bar,
        muted: Array.from({ length: s.channels }, (_, c) => muted[c] === true),
        resampler: prefs.resampler,
        stereoSeparation: prefs.stereoSeparation,
        volumeRamps: prefs.volumeRamps,
        amplify: prefs.amplify,
        karplusStrong: prefs.karplusStrong,
      },
      {
        signal: controller.signal,
        preview: $('#video-preview'),
        onProgress: (fraction) => (videoProgress.value = fraction),
        onRecording: () => (videoInfo.textContent = t('This browser records the video in real time: keep this tab in front until it is done.')),
      },
    );
    const bytes = result.data instanceof Blob ? new Uint8Array(await result.data.arrayBuffer()) : result.data;
    download(bytes, result.fileName, result.fileName.endsWith('.webm') ? 'video/webm' : 'video/mp4');
    track('export-video', { size: `${width}x${height}`, recorded: result.recorded });
    const took = ((performance.now() - started) / 1000).toFixed(1);
    const details = { file: result.fileName, length: formatTime(result.seconds), size: (bytes.length / 1e6).toFixed(1), took };
    videoDone(
      result.recorded
        ? t('{file}: {length} of video, {size} MB, recorded in {took} s.', details)
        : t('{file} ({codecs}): {length} of video, {size} MB, rendered in {took} s.', { ...details, codecs: result.codecs }),
    );
  } catch (error) {
    const { name, message } = error as Error;
    videoDone(name === 'AbortError' ? t('Export cancelled.') : t('Export failed: {error}', { error: message }));
  }
}

function videoDone(message: string): void {
  videoExport = null;
  videoGo.textContent = t('Render video');
  videoProgress.hidden = true;
  $('#video-preview').replaceChildren();
  videoInfo.textContent = message;
  status.textContent = message;
}

if (!canExportVideo()) {
  videoGo.disabled = true;
  videoInfo.textContent = t("This browser can't make videos. Chrome, Edge and Firefox can.");
}

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
    await writeAutosave(s.title, saveXm(s), fresh, Date.now(), originOf(s));
  } catch {
    // Private windows and some browsers refuse IndexedDB; the tracker works without it.
  }
}

async function showAutosaves(): Promise<void> {
  const list = $('#autosave-list');
  let versions: Autosave[] = [];
  try {
    versions = await listAutosaves();
  } catch (error) {
    list.replaceChildren(listNote(storageProblem(error)));
    return;
  }
  const items = versions.map((v) => {
    const li = document.createElement('li');
    const when = new Date(v.savedAt);
    const time = document.createElement('span');
    time.className = 'idx';
    time.textContent = `${when.toLocaleDateString(language())} ${when.toLocaleTimeString(language(), { hour: '2-digit', minute: '2-digit' })}`;
    li.append(time, ` ${v.title || t('untitled')}`);
    li.title = t('Open this version');
    li.addEventListener('click', async () => {
      if (!(await confirmDiscard())) return;
      fileDialog.close();
      restoreAutosave(v);
    });
    return li;
  });
  if (!items.length) items.push(Object.assign(document.createElement('li'), { textContent: t('Nothing saved yet.') }));
  list.replaceChildren(...items);
}

function restoreAutosave(version: Autosave): void {
  try {
    startSong(applyOrigin(loadModule(version.bytes.slice().buffer, 'autosave.xm'), version.origin));
    status.textContent = t('Restored {title} from {time}.', { title: version.title || t('untitled'), time: new Date(version.savedAt).toLocaleString(language()) });
  } catch (error) {
    status.textContent = t('Could not restore the autosave: {error}', { error: (error as Error).message });
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

// ---- Library: songs kept in this browser ---------------------------------

const songsDialog = $<HTMLDialogElement>('#songs-dialog');
const libraryName = $<HTMLInputElement>('#library-name');
const libraryList = $('#library-list');
const libraryInfo = $('#library-info');
/** The library song the current song was opened from or last saved as. */
let libraryEntry: { id: number; name: string } | null = null;
let librarySongs: LibrarySong[] = [];
let librarySelected = -1;

function listNote(text: string): HTMLLIElement {
  const li = Object.assign(document.createElement('li'), { textContent: text });
  li.style.whiteSpace = 'normal';
  return li;
}

/** Why the browser storage failed, in words for the user. */
function storageProblem(error: unknown): string {
  return (error as Error).message === BLOCKED ? t(BLOCKED) : t('Not available in this browser.');
}

function openSongsDialog(): void {
  libraryName.value = libraryEntry?.name ?? (song().title.trim() || t('untitled'));
  void showLibrary();
  songsDialog.showModal();
}

async function showLibrary(): Promise<void> {
  try {
    librarySongs = await listSongs();
  } catch (error) {
    librarySongs = [];
    libraryList.replaceChildren(listNote(storageProblem(error)));
    selectLibrarySong(-1);
    return;
  }
  const items = librarySongs.map((entry, i) => {
    const li = document.createElement('li');
    const when = new Date(entry.savedAt);
    const time = document.createElement('span');
    time.className = 'idx';
    time.textContent = `${when.toLocaleDateString(language())} ${when.toLocaleTimeString(language(), { hour: '2-digit', minute: '2-digit' })}`;
    li.append(time, ` ${entry.name}`);
    li.title = t('Double-click to open');
    li.addEventListener('click', () => selectLibrarySong(i));
    li.addEventListener('dblclick', () => void openLibrarySong());
    return li;
  });
  if (!items.length) items.push(listNote(t('No songs saved here yet.')));
  libraryList.replaceChildren(...items);
  selectLibrarySong(Math.max(0, librarySongs.findIndex((e) => e.id === libraryEntry?.id)));
}

function selectLibrarySong(index: number): void {
  librarySelected = librarySongs.length ? index : -1;
  libraryList.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === librarySelected)));
  for (const id of ['#library-open', '#library-rename', '#library-delete']) $<HTMLButtonElement>(id).disabled = librarySelected < 0;
}

async function saveToLibrary(): Promise<void> {
  const name = libraryName.value.trim() || t('untitled');
  const same = librarySongs.find((e) => e.name === name);
  if (same && same.id !== libraryEntry?.id && !(await ask(t('Replace the saved song "{name}"?', { name }), { title: t('Save'), ok: t('Replace') }))) return;
  const s = song();
  try {
    const id = await putSong({ id: same?.id, name, savedAt: Date.now(), bytes: saveXm(s), origin: originOf(s) });
    libraryEntry = { id, name };
    editor.dirty = false;
    renderTabs();
    status.textContent = t('Saved {name} in this browser.', { name });
    track('library-save');
    libraryInfo.textContent = status.textContent;
    await showLibrary();
  } catch (error) {
    libraryInfo.textContent = t('Could not save: {error}', { error: (error as Error).message });
  }
}

async function openLibrarySong(): Promise<void> {
  const entry = librarySongs[librarySelected];
  if (!entry || !(await confirmDiscard())) return;
  try {
    startSong(applyOrigin(loadModule(entry.bytes.slice().buffer, `${entry.name}.xm`), entry.origin));
    libraryEntry = { id: entry.id, name: entry.name };
    renderTabs();
    songsDialog.close();
    status.textContent = t('Opened {name}.', { name: entry.name });
  } catch (error) {
    libraryInfo.textContent = t('Could not open {name}: {error}', { name: entry.name, error: (error as Error).message });
  }
}

async function renameLibrarySong(): Promise<void> {
  const entry = librarySongs[librarySelected];
  const name = entry && (await askText(t('New name:'), entry.name, { title: t('Rename'), ok: t('Rename') }))?.trim();
  if (!entry || !name || name === entry.name) return;
  await renameSong(entry.id, name);
  if (libraryEntry?.id === entry.id) libraryEntry.name = libraryName.value = name;
  await showLibrary();
}

async function deleteLibrarySong(): Promise<void> {
  const entry = librarySongs[librarySelected];
  if (!entry || !(await ask(t('Delete "{name}" from this browser?', { name: entry.name }), { title: t('Delete'), ok: t('Delete') }))) return;
  await deleteSong(entry.id);
  if (libraryEntry?.id === entry.id) libraryEntry = null;
  await showLibrary();
}

const songCount = (count: number) => (count === 1 ? t('{count} song', { count }) : t('{count} songs', { count }));

/** The tracker's settings as kept in localStorage, for a backup. */
function storedSettings(): Record<string, string> {
  const settings: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = key && isSettingsKey(key) ? localStorage.getItem(key) : null;
      if (key && value !== null) settings[key] = value;
    }
  } catch {
    // Storage is off; back up the songs alone.
  }
  return settings;
}

const today = () => {
  const day = new Date();
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
};

const backupError = (error: unknown) => (error instanceof Error && error.message === BLOCKED ? t(BLOCKED) : (error as Error).message);

/** Downloads the songs, and with `withSettings` the settings too, as one ZIP. */
async function downloadBackup(withSettings: boolean, info: HTMLElement): Promise<void> {
  try {
    const songs = await listSongs();
    if (!songs.length && !withSettings) {
      info.textContent = t('No songs saved here yet.');
      return;
    }
    const file = `chiptrackr-${withSettings ? 'backup' : 'songs'}-${today()}.zip`;
    download(createBackup(songs, withSettings ? storedSettings() : undefined), file, 'application/zip');
    track('library-backup', { songs: songs.length, settings: withSettings });
    const saved = { songs: songCount(songs.length), file };
    info.textContent = withSettings ? t('Saved {songs} and the settings to {file}.', saved) : t('Saved {songs} to {file}.', saved);
  } catch (error) {
    info.textContent = t('Could not back up: {error}', { error: backupError(error) });
  }
}

/**
 * Adds the songs of a backup ZIP to the library, then, with `withSettings`
 * and if the backup has any, offers to take its settings (which reloads).
 * Returns what was added, or null when nothing could be read.
 */
async function restoreBackup(bytes: Uint8Array, source: string, withSettings: boolean, info: HTMLElement): Promise<{ added: number; skipped: number } | null> {
  try {
    const { songs, failed, settings } = readBackup(bytes);
    const useSettings = withSettings ? settings : undefined;
    if (!songs.length && !useSettings) {
      info.textContent = t('No songs found in {file}.', { file: source });
      return null;
    }
    const { add, skipped } = planRestore(await listSongs(), songs);
    await addSongs(add);
    track('library-restore', { songs: add.length, settings: !!useSettings });
    if (songsDialog.open) await showLibrary();
    info.textContent = [
      t('Added {songs} from {file}.', { songs: songCount(add.length), file: source }),
      skipped ? t('Already here: {songs}.', { songs: songCount(skipped) }) : '',
      failed.length ? t('Could not read: {files}', { files: failed.join(', ') }) : '',
    ].filter(Boolean).join(' ');
    if (useSettings) {
      // Answer the caller first, so a sending browser hears back before this one reloads.
      setTimeout(() => void offerSettings(useSettings));
    }
    return { added: add.length, skipped };
  } catch (error) {
    info.textContent = t('Could not restore {file}: {error}', { file: source, error: backupError(error) });
    return null;
  }
}

async function offerSettings(settings: Record<string, string>): Promise<void> {
  const replace = await ask(t('The backup also holds settings (Setup, colours, Jam name). Replace the settings here with them? The tracker reloads; your song is kept, but other open song tabs and the undo history are not.'), {
    title: t('Restore settings'),
    ok: t('Replace and reload'),
    cancel: t('Keep mine'),
  });
  if (!replace) return;
  try {
    for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
  } catch {
    status.textContent = t('Not available in this browser.');
    return;
  }
  await autosaveNow();
  reloading = true;
  location.reload();
}

/** A file input that hands its file over, readied for picking again. */
function onFilePicked(input: HTMLInputElement, use: (file: File) => void): void {
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) use(file);
  });
}

const restoreFile = $<HTMLInputElement>('#library-restore-file');
$('#library-backup').addEventListener('click', () => void downloadBackup(false, libraryInfo));
$('#library-restore').addEventListener('click', () => restoreFile.click());
onFilePicked(restoreFile, (file) => void file.arrayBuffer().then((buffer) => restoreBackup(new Uint8Array(buffer), file.name, false, libraryInfo)));
$('#songs-open').addEventListener('click', openSongsDialog);
$('#library-save').addEventListener('click', () => void saveToLibrary());
$('#library-open').addEventListener('click', () => void openLibrarySong());
$('#library-rename').addEventListener('click', () => void renameLibrarySong());
$('#library-delete').addEventListener('click', () => void deleteLibrarySong());
libraryName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void saveToLibrary();
});

// ---- Share links -----------------------------------------------------------

const shareDialog = $<HTMLDialogElement>('#share-dialog');
const shareQuality = $<HTMLSelectElement>('#share-quality');
const shareUrl = $<HTMLInputElement>('#share-url');
const shareInfo = $('#share-info');
const shareSend = $<HTMLButtonElement>('#share-send');
const shareFile = $<HTMLButtonElement>('#share-file');
/** Beyond this many characters chat apps and mail start to cut links off. */
const LONG_LINK = 8000;
let sharePacking = 0;

function openShareDialog(): void {
  shareSend.hidden = !('share' in navigator);
  shareFile.hidden = !('share' in navigator);
  void updateShareLink();
  shareDialog.showModal();
}

async function updateShareLink(): Promise<void> {
  const packing = ++sharePacking;
  shareUrl.value = '';
  shareInfo.textContent = t('Packing…');
  const s = song();
  try {
    const xm = saveXm(shrinkSong(s, shareQuality.value as ShareQuality));
    const text = await encodeShare(xm, originOf(s));
    if (packing !== sharePacking) return;
    const url = new URL(location.href);
    url.hash = `${SHARE_PARAM}=${text}`;
    shareUrl.value = url.href;
    const length = url.href.length.toLocaleString(language());
    shareInfo.textContent =
      url.href.length > LONG_LINK
        ? t('{length} characters. Chat apps and mail may cut a link this long; a smaller quality or Send file is safer.', { length })
        : t('{length} characters. The song travels inside the link; nothing is uploaded.', { length });
  } catch (error) {
    if (packing === sharePacking) shareInfo.textContent = t('Could not make a link: {error}', { error: (error as Error).message });
  }
}

async function copyShareLink(): Promise<void> {
  if (!shareUrl.value) return;
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    shareInfo.textContent = t('Link copied.');
    track('share-copy');
  } catch {
    shareUrl.select();
    shareInfo.textContent = t('Select the link and copy it.');
  }
}

async function sendShare(withFile: boolean): Promise<void> {
  const s = song();
  const title = s.title.trim() || t('untitled');
  const name = `${safeName(s.title, 'untitled')}.xm`;
  const bytes = saveXm(s);
  const file = new File([bytes as BlobPart], name, { type: 'application/octet-stream' });
  // Phone share sheets take only some file types (pictures, common audio, PDF); XM is not
  // one of them on Android, so the file is downloaded instead, to be sent from there.
  if (withFile && !navigator.canShare?.({ files: [file] })) {
    downloadForSending(bytes, name);
    return;
  }
  try {
    await navigator.share(withFile ? { title, files: [file] } : { title, url: shareUrl.value });
    track('share-send', { file: withFile });
  } catch (error) {
    const reason = (error as Error).name;
    if (reason === 'AbortError') return;
    if (withFile && reason === 'NotAllowedError') downloadForSending(bytes, name);
    else shareInfo.textContent = t('Could not share: {error}', { error: (error as Error).message });
  }
}

function downloadForSending(bytes: Uint8Array, name: string): void {
  download(bytes, name, 'application/octet-stream');
  shareInfo.textContent = t("This browser can't send {file} directly, so it was downloaded; send it from your downloads.", { file: name });
}

/** Opens the song in a `#song=…` link; returns the error, if any. */
async function openSharedSong(text: string): Promise<string | null> {
  // Drop the song from the address, so a reload doesn't throw away later edits.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const { xm, origin } = await decodeShare(text);
    const loaded = applyOrigin(loadModule(xm.slice().buffer, 'shared.xm'), origin);
    startSong(loaded);
    status.textContent = t('Opened the shared song {title}.', { title: loaded.title.trim() || t('untitled') });
    track('open-shared');
    return null;
  } catch (error) {
    return t('Could not open the shared song: {error}.', { error: (error as Error).message });
  }
}

$('#share-open').addEventListener('click', openShareDialog);
shareQuality.addEventListener('change', () => void updateShareLink());
$('#share-copy').addEventListener('click', () => void copyShareLink());
shareSend.addEventListener('click', () => void sendShare(false));
shareFile.addEventListener('click', () => void sendShare(true));
shareUrl.addEventListener('focus', () => shareUrl.select());
window.addEventListener('hashchange', () => {
  const offer = transferFromHash(location.hash);
  if (offer) return openTransferOffer(offer);
  const invite = jamFromHash(location.hash);
  if (invite) return openJamInvite(invite);
  const text = shareFromHash(location.hash);
  if (text) {
    void (async () => {
      if (!(await confirmDiscard())) return;
      const error = await openSharedSong(text);
      if (error) status.textContent = error;
    })();
  }
});

// ---- Jam: editing one song together ------------------------------------------

const jamDialog = $<HTMLDialogElement>('#jam-dialog');
const jamName = $<HTMLInputElement>('#jam-name');
const jamInfo = $('#jam-info');
const jamInviteUrl = $<HTMLInputElement>('#jam-invite-url');
const jamAnswer = $<HTMLInputElement>('#jam-answer');
const jamAnswerOut = $<HTMLInputElement>('#jam-answer-out');
const JAM_NAME_KEY = 'webtracker.jamName';
let jam: JamSession | null = null;
/** Host: the room other tabs of this browser join, and how to stop listening there. */
let jamRoom = '';
let stopTabs: (() => void) | null = null;
/** Host: the invite waiting for its answer code. */
let jamInvite: Invite | null = null;
/** Guest: an invite opened from a link, waiting for Join. */
let pendingInvite: { kind: 'rtc' | 'tab'; value: string } | null = null;
let cancelAnswer: (() => void) | null = null;
let adoptingJamSong = false;

try {
  jamName.value = localStorage.getItem(JAM_NAME_KEY) ?? '';
} catch {
  // Without storage the name is asked for each time.
}
jamName.addEventListener('change', () => {
  try {
    localStorage.setItem(JAM_NAME_KEY, jamName.value.trim());
  } catch {
    // Only a convenience.
  }
});

const jamDoc: JamDocument = {
  song: () => editor.song,
  applied: (edits) => editor.applyRemote(edits, edits.some((e) => e.kind === 'song') ? 'channels' : 'jam'),
  adopt: (next) => {
    adoptingJamSong = true;
    try {
      startSong(next);
    } finally {
      adoptingJamSong = false;
    }
  },
};
editor.onEdit = (edit) => jam?.local(edit);

let lastCursor = '';
view.onMoved = () => {
  if (!jam?.active) return;
  const cursor = { pattern: view.patternIndex, row: view.row, channel: view.channel };
  const key = `${cursor.pattern}:${cursor.row}:${cursor.channel}`;
  if (key === lastCursor) return;
  lastCursor = key;
  jam.cursor(cursor);
};

function showPeers(): void {
  const session = jam;
  if (!session) return view.setPeers([]);
  const marks = [...session.cursors].flatMap(([id, cursor]) => {
    const peer = session.peers.find((p) => p.id === id);
    return peer ? [{ ...cursor, colour: peer.colour, name: peer.name }] : [];
  });
  view.setPeers(marks);
}

function jamPersonName(): string {
  return jamName.value.trim() || t('Anonymous');
}

function wireJam(session: JamSession): void {
  jam = session;
  lastCursor = '';
  session.onPeers = () => renderJam();
  session.onCursors = showPeers;
  session.onJoined = () => {
    status.textContent = t('You joined the jam: {people}.', { people: session.peers.map((p) => p.name).join(', ') });
    jamInfo.textContent = t('You are in. Edits show up for everyone as you make them.');
    pendingInvite = null;
    view.onMoved?.();
    renderJam();
  };
  session.onEnd = (reason) => {
    if (jam === session) jam = null;
    stopTabs?.();
    stopTabs = null;
    jamInvite?.cancel();
    jamInvite = null;
    status.textContent = reason;
    jamInfo.textContent = reason;
    showPeers();
    renderJam();
  };
}

function leaveJam(reason?: string): void {
  if (!jam) return;
  const session = jam;
  session.leave();
  if (reason) status.textContent = reason;
}

function startJam(): void {
  if (jam) return;
  const session = JamSession.host(jamDoc, jamPersonName());
  wireJam(session);
  jamRoom = newRoom();
  stopTabs = listenInTabs(jamRoom, (link) => session.addGuest(link));
  jamInfo.textContent = t('The jam is on. Invite people with a link, one link per person.');
  status.textContent = t('Jam started.');
  track('jam-start');
  view.onMoved?.();
  renderJam();
}

function jamAddress(param: string, value: string): string {
  const url = new URL(location.href);
  url.hash = `${param}=${value}`;
  return url.href;
}

async function newJamInvite(): Promise<void> {
  jamInvite?.cancel();
  jamInvite = null;
  jamInfo.textContent = t('Making an invite…');
  try {
    const invite = await createInvite();
    if (!jam?.active) return invite.cancel();
    jamInvite = invite;
    jamInviteUrl.value = jamAddress(JAM_PARAM, invite.offer);
    jamAnswer.value = '';
    jamInfo.textContent = '';
  } catch (error) {
    jamInfo.textContent = t('Could not make an invite: {error}.', { error: (error as Error).message });
  }
  renderJam();
}

async function connectJamGuest(): Promise<void> {
  const invite = jamInvite;
  const session = jam;
  if (!invite || !session || !jamAnswer.value.trim()) return;
  jamInfo.textContent = t('Connecting…');
  try {
    const link = await invite.accept(jamAnswer.value);
    session.addGuest(link);
    jamInvite = null;
    jamInviteUrl.value = '';
    jamInfo.textContent = t('Connected. Make another invite for the next person.');
  } catch (error) {
    jamInfo.textContent = t('Could not connect: {error}.', { error: (error as Error).message });
  }
  renderJam();
}

/** Opens the Jam dialog for an invite link someone sent. */
function openJamInvite(invite: { kind: 'rtc' | 'tab'; value: string }): void {
  history.replaceState(null, '', location.pathname + location.search);
  if (jam?.active) {
    status.textContent = t('You are in a jam already; leave it to join another.');
    return;
  }
  pendingInvite = invite;
  jamAnswerOut.value = '';
  jamInfo.textContent = '';
  renderJam();
  if (!jamDialog.open) jamDialog.showModal();
  // Tabs of this browser need no answer code, so they join straight away.
  if (invite.kind === 'tab') void joinJam();
}

function joinWith(link: Link): void {
  wireJam(JamSession.join(jamDoc, jamPersonName(), link));
  track('jam-join');
  jamInfo.textContent = t('Waiting for the song…');
  renderJam();
}

async function joinJam(): Promise<void> {
  const invite = pendingInvite;
  if (!invite) return;
  if (invite.kind === 'tab') return joinWith(joinInTab(invite.value));
  cancelAnswer?.();
  jamInfo.textContent = t('Making your answer code…');
  try {
    const { answer, link, cancel } = await answerInvite(invite.value);
    cancelAnswer = cancel;
    jamAnswerOut.value = answer;
    jamInfo.textContent = '';
    renderJam();
    joinWith(await link);
    cancelAnswer = null;
  } catch (error) {
    jamInfo.textContent = t('Could not join: {error}.', { error: (error as Error).message });
    renderJam();
  }
}

/** Copies a code or link; `copied` and `select` are the messages for success and for copying by hand. */
async function copyField(field: HTMLInputElement, copied: string, select: string, info: HTMLElement = jamInfo): Promise<void> {
  if (!field.value) return;
  try {
    await navigator.clipboard.writeText(field.value);
    info.textContent = copied;
  } catch {
    field.select();
    info.textContent = select;
  }
}

function renderJam(): void {
  const session = jam?.active || jam?.role === 'guest' ? jam : null;
  const hosting = session?.role === 'host';
  const joining = !session && pendingInvite !== null;
  $('#jam-start').hidden = !!session || joining;
  $('#jam-hosting').hidden = !hosting;
  $('#jam-invite-box').hidden = !hosting || !jamInvite;
  $('#jam-joining').hidden = !joining && !(session?.role === 'guest' && !session.active);
  $('#jam-join').hidden = !joining || !!jamAnswerOut.value;
  $('#jam-answer-box').hidden = !jamAnswerOut.value || !!session?.active;
  $('#jam-leave').hidden = !session;
  jamName.disabled = !!session;
  const people = session?.active ? session.peers : [];
  $('#jam-people-box').hidden = people.length === 0;
  $('#jam-people').replaceChildren(
    ...people.map((peer) => {
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.setProperty('--peer', peer.colour);
      li.append(swatch, peer.id === session!.me ? t('{name} (you)', { name: peer.name }) : peer.id === 0 ? t('{name} (host)', { name: peer.name }) : peer.name);
      return li;
    }),
  );
  const button = $('#jam-open');
  button.setAttribute('aria-pressed', String(!!session?.active));
  button.title = session?.active ? t('In a jam with {people}', { people: people.map((p) => p.name).join(', ') }) : t('Edit this song together with others, live');
}

$('#jam-open').addEventListener('click', () => {
  renderJam();
  jamDialog.showModal();
});
$('#jam-host').addEventListener('click', startJam);
$('#jam-invite').addEventListener('click', () => void newJamInvite());
$('#jam-tab').addEventListener('click', () => {
  if (jam?.active) window.open(jamAddress(JAM_TAB_PARAM, jamRoom), '_blank');
});
$('#jam-invite-copy').addEventListener('click', () => void copyField(jamInviteUrl, t('Invite copied.'), t('Select the invite and copy it.')));
$('#jam-connect').addEventListener('click', () => void connectJamGuest());
$('#jam-join').addEventListener('click', () => void joinJam());
$('#jam-answer-copy').addEventListener('click', () => void copyField(jamAnswerOut, t('Answer code copied.'), t('Select the answer code and copy it.')));
$('#jam-leave').addEventListener('click', async () => {
  if (jam?.role === 'host' && jam.peers.length > 1 && !(await ask(t('Leaving ends the jam for everyone. Go on?'), { title: t('Jam'), ok: t('Leave') }))) return;
  if (jam) leaveJam();
  else {
    cancelAnswer?.();
    pendingInvite = null;
  }
  jamAnswerOut.value = '';
  renderJam();
});
jamInviteUrl.addEventListener('focus', () => jamInviteUrl.select());
jamAnswerOut.addEventListener('focus', () => jamAnswerOut.select());
addEventListener('pagehide', () => jam?.leave());

// ---- Backup and transfer (Setup) --------------------------------------------
// A transfer is a one-off WebRTC link like a jam's: the sending browser makes
// a link with its offer, the receiving one answers with a code, then the
// sender sends one backup ZIP and the receiver replies with what it added.

const transferDialog = $<HTMLDialogElement>('#transfer-dialog');
const transferUrl = $<HTMLInputElement>('#transfer-url');
const transferAnswer = $<HTMLInputElement>('#transfer-answer');
const transferAnswerOut = $<HTMLInputElement>('#transfer-answer-out');
const transferInfo = $('#transfer-info');
let transferInvite: Invite | null = null;
let transferOffer: string | null = null;
let transferCancel: (() => void) | null = null;
let transferLink: Link | null = null;

function renderTransfer(): void {
  const receiving = transferOffer !== null;
  $('#transfer-start').hidden = receiving || !!transferInvite;
  $('#transfer-sending').hidden = receiving || !transferInvite;
  $('#transfer-receiving').hidden = !receiving;
  $('#transfer-accept').hidden = !!transferAnswerOut.value;
  $('#transfer-answer-box').hidden = !transferAnswerOut.value;
}

function endTransfer(): void {
  transferInvite?.cancel();
  transferCancel?.();
  transferLink?.close();
  transferInvite = transferLink = transferCancel = transferOffer = null;
  transferUrl.value = transferAnswer.value = transferAnswerOut.value = '';
}

function openTransferDialog(): void {
  if (!transferDialog.open) {
    if (!transferLink) transferInfo.textContent = '';
    transferDialog.showModal();
  }
  renderTransfer();
}

async function makeTransferLink(): Promise<void> {
  endTransfer();
  transferInfo.textContent = t('Making a transfer link…');
  try {
    transferInvite = await createInvite();
    transferUrl.value = jamAddress(TRANSFER_PARAM, transferInvite.offer);
    transferInfo.textContent = '';
  } catch (error) {
    transferInfo.textContent = t('Could not make a transfer link: {error}.', { error: (error as Error).message });
  }
  renderTransfer();
}

/** Sender: connects with the answer code, sends everything and waits for the receipt. */
async function sendTransfer(): Promise<void> {
  const invite = transferInvite;
  if (!invite || !transferAnswer.value.trim()) return;
  transferInfo.textContent = t('Connecting…');
  try {
    const link = await invite.accept(transferAnswer.value);
    transferLink = link;
    const songs = await listSongs();
    const settings = storedSettings();
    link.onMessage = (bytes) => {
      let reply: { added?: number; skipped?: number } = {};
      try {
        reply = JSON.parse(new TextDecoder().decode(bytes)) as typeof reply;
      } catch {
        // An empty receipt still means it arrived.
      }
      transferInfo.textContent = t('Sent {songs} and the settings. The other browser added {added}.', { songs: songCount(songs.length), added: songCount(reply.added ?? 0) });
      track('transfer-send', { songs: songs.length });
      endTransfer();
      renderTransfer();
    };
    link.onClose = () => {
      if (transferLink !== link) return;
      transferInfo.textContent = t('The other browser went away before the transfer was done.');
      endTransfer();
      renderTransfer();
    };
    transferInfo.textContent = t('Sending {songs}…', { songs: songCount(songs.length) });
    link.send(createBackup(songs, settings));
  } catch (error) {
    transferInfo.textContent = t('Could not connect: {error}.', { error: (error as Error).message });
  }
}

/** Receiver: opened from a transfer link. */
function openTransferOffer(offer: string): void {
  history.replaceState(null, '', location.pathname + location.search);
  endTransfer();
  transferOffer = offer;
  transferInfo.textContent = '';
  openTransferDialog();
}

async function receiveTransfer(): Promise<void> {
  const offer = transferOffer;
  if (!offer) return;
  transferInfo.textContent = t('Making your answer code…');
  try {
    const { answer, link, cancel } = await answerInvite(offer, t('This is not a transfer link'));
    transferCancel = cancel;
    transferAnswerOut.value = answer;
    transferInfo.textContent = '';
    renderTransfer();
    const open = await link;
    transferLink = open;
    transferInfo.textContent = t('Connected. Receiving…');
    open.onMessage = (bytes) =>
      void (async () => {
        const result = await restoreBackup(bytes, t('the other browser'), true, transferInfo);
        open.send(new TextEncoder().encode(JSON.stringify(result ?? { added: 0, skipped: 0 })));
        track('transfer-receive', { songs: result?.added ?? 0 });
        transferLink = null;
        transferCancel = null;
        transferOffer = null;
        transferAnswerOut.value = '';
        renderTransfer();
      })();
    open.onClose = () => {
      if (transferLink !== open) return;
      transferInfo.textContent = t('The other browser went away before the transfer was done.');
      transferLink = null;
    };
  } catch (error) {
    transferInfo.textContent = t('Could not receive: {error}.', { error: (error as Error).message });
    renderTransfer();
  }
}

const backupFile = $<HTMLInputElement>('#backup-file');
$('#backup-all').addEventListener('click', () => void downloadBackup(true, $('#setup-info')));
$('#backup-restore').addEventListener('click', () => backupFile.click());
onFilePicked(backupFile, (file) => void file.arrayBuffer().then((buffer) => restoreBackup(new Uint8Array(buffer), file.name, true, $('#setup-info'))));
$('#transfer-open').addEventListener('click', () => {
  if (!transferLink && !transferAnswerOut.value) endTransfer();
  openTransferDialog();
});
$('#transfer-send').addEventListener('click', () => void makeTransferLink());
$('#transfer-copy').addEventListener('click', () => void copyField(transferUrl, t('Link copied.'), t('Select the link and copy it.'), transferInfo));
$('#transfer-connect').addEventListener('click', () => void sendTransfer());
$('#transfer-accept').addEventListener('click', () => void receiveTransfer());
$('#transfer-answer-copy').addEventListener('click', () => void copyField(transferAnswerOut, t('Answer code copied.'), t('Select the answer code and copy it.'), transferInfo));
transferUrl.addEventListener('focus', () => transferUrl.select());
transferAnswerOut.addEventListener('focus', () => transferAnswerOut.select());

/** On start, a shared song from the link wins over the last session. */
async function startUp(): Promise<void> {
  const offer = transferFromHash(location.hash);
  if (offer) {
    await restoreLastSession();
    openTransferOffer(offer);
    return;
  }
  const invite = jamFromHash(location.hash);
  if (invite) {
    await restoreLastSession();
    openJamInvite(invite);
    return;
  }
  const text = shareFromHash(location.hash);
  const error = text ? await openSharedSong(text) : null;
  if (text && !error) return;
  await restoreLastSession();
  if (error) status.textContent = error;
}

$('#new').addEventListener('click', async () => {
  if (!(await confirmDiscard())) return;
  startSong(createSong());
  // A new song stays replaceable until it is edited.
  blankTab = true;
  status.textContent = t('New song: 4 channels, five chip instruments.');
});
$('#load').addEventListener('click', () => fileInput.click());
$('#save').addEventListener('click', openFileDialog);
$('#save-xm').addEventListener('click', saveSong);
$('#save-mod').addEventListener('click', saveSongAsMod);
$('#open-replayer').addEventListener('click', () => void openInReplayer());
exportGo.addEventListener('click', exportAudio);
videoGo.addEventListener('click', () => void startVideoExport());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  if (PATTERN_NAME.test(file.name)) void importPatternFile(file);
  // A sample picked here goes where a dropped one would; anything else is tried as a module by its content.
  else if (SAMPLE_NAME.test(file.name) && !MODULE_NAME.test(file.name)) void importIntoSlot(file);
  else void openModule(file);
});

// ---- Pattern and track files (.xp, .xt) -------------------------------------

function savePatternFile(track: boolean): void {
  const index = view.patternIndex;
  const pattern = view.pattern;
  const name = `${safeName(song().title, 'untitled')}-${hex(index, 2)}${track ? `-ch${view.channel + 1}` : ''}`;
  if (track) download(saveXt(song(), pattern, view.channel), `${name}.xt`, 'application/octet-stream');
  else download(saveXp(song(), pattern), `${name}.xp`, 'application/octet-stream');
  $('#save-info').textContent = status.textContent = track
    ? t('Saved channel {channel} of pattern {pattern} as {file}.', { channel: view.channel + 1, pattern: hex(index, 2), file: `${name}.xt` })
    : t('Saved pattern {pattern} as {file}.', { pattern: hex(index, 2), file: `${name}.xp` });
}

/** An .xp file replaces the current pattern, an .xt file the cursor's channel; both undo. */
async function importPatternFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (/\.xt$/i.test(file.name)) {
      const cells = loadXt(bytes);
      const channel = view.channel;
      editor.editPattern(view.patternIndex, 'load track', (p) => applyTrack(song(), p, channel, cells));
      status.textContent = t('Loaded {file} into channel {channel}.', { file: file.name, channel: channel + 1 });
    } else {
      const { pattern, droppedChannels } = loadXp(bytes, song().channels);
      editor.editPattern(view.patternIndex, 'load pattern', () => pattern);
      const loaded = { file: file.name, rows: pattern.rows, dropped: droppedChannels, channels: song().channels };
      status.textContent = droppedChannels
        ? t('Loaded {file}, {rows} rows; {dropped} channels past {channels} were left out.', loaded)
        : t('Loaded {file}, {rows} rows.', loaded);
    }
    showPosition();
  } catch (error) {
    loadFailed(file, error);
  }
}
$('#save-xp').addEventListener('click', () => savePatternFile(false));
$('#save-xt').addEventListener('click', () => savePatternFile(true));
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
  if (MODULE_NAME.test(file.name)) void openModule(file);
  else if (PATTERN_NAME.test(file.name)) void importPatternFile(file);
  else void importIntoSlot(file);
});
/** Set when Setup reloads for a new language, after asking. */
let reloading = false;
window.addEventListener('beforeunload', (event) => {
  if (reloading) return;
  if (editor.dirty || tabs.some((tab, i) => i !== activeTab && tab.doc.dirty)) event.preventDefault();
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
  editInfo.textContent = t('Applies to the range above; Ctrl+Z undoes it.');
  editTools.showModal();
}

/** `done` reports the count of changed cells, e.g. 'Transpose: {count} notes changed.'. */
function runEditTool(label: string, tool: (pattern: Pattern, block: Block) => number, done: string, none: string): void {
  const changed = applyRange(editRange.value as EditRange, label, tool);
  editInfo.textContent = changed ? t(done, { count: changed }) : t(none);
  status.textContent = editInfo.textContent;
}

$('#edit-tools-open').addEventListener('click', openEditTools);
$('#tr-go').addEventListener('click', () => {
  const amount = Math.trunc(numberField('#tr-amount'));
  const ins = hexField('#tr-ins') || 0;
  if (!amount) return;
  runEditTool('transpose', (p, b) => transposeBlock(song(), p, b, amount, ins), msg('Transpose: {count} notes changed.'), msg('Transpose: nothing to change.'));
});
$('#rm-go').addEventListener('click', () => {
  const from = hexField('#rm-from');
  const to = hexField('#rm-to');
  if (!(from >= 1 && from <= 128 && to >= 1 && to <= 128) || from === to) {
    editInfo.textContent = t('Instrument numbers are hex, 01 to 80.');
    return;
  }
  runEditTool('remap instrument', (p, b) => remapInstrument(song(), p, b, from, to), msg('Remap instrument: {count} cells changed.'), msg('Remap instrument: nothing to change.'));
});
$('#sc-go').addEventListener('click', () => {
  const start = Math.max(0, numberField('#sc-start'));
  const end = Math.max(0, numberField('#sc-end'));
  runEditTool('scale volume', (p, b) => scaleVolumeBlock(song(), p, b, start, end), msg('Scale volume: {count} volumes changed.'), msg('Scale volume: nothing to change.'));
});

const songStatsDialog = mountSongStats($<HTMLDialogElement>('#stats-dialog'), {
  song,
  optimize(options) {
    let result!: CleanupResult;
    editor.editSong('clean up', (s) => {
      result = cleanupSong(s, options);
    });
    status.textContent = t('Song optimized; Ctrl+Z undoes it.');
    track('optimize');
    return result;
  },
});
$('#stats-open').addEventListener('click', () => {
  setSheet(false);
  songStatsDialog.open();
});
$('#edit-stats').addEventListener('click', () => {
  editTools.close();
  songStatsDialog.open();
});

// Help opened with the cursor on a volume or effect jumps to its explanation.
const help = mountHelp($<HTMLDialogElement>('#help'));
$('#help-open').addEventListener('click', () => {
  const field = view.column >= Column.Effect ? 'effect' : view.column >= Column.VolHi ? 'volume' : null;
  setSheet(false);
  help.open(app.dataset.view === 'pattern' && field ? cellHelpTarget(field, cursorCell()) : null);
});

// What's new opens from Help, and by itself once after an update for returning visitors.
const whatsNew = mountWhatsNew($<HTMLDialogElement>('#whats-new'));
$('#whats-new-open').addEventListener('click', () => whatsNew.open());

const link = (href: string, text: string): HTMLAnchorElement => Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener', textContent: text });
$('#about-info').append(
  ...tNodes('A tracker for chiptunes, modules and the demoscene, right in your browser. Free and open source: the code is on {github} under the {license} ({notices}). Click the demo to pause it.', {
    github: link('https://github.com/wirehack7/webtracker', 'GitHub'),
    license: link('LICENSE.txt', t('MIT License')),
    notices: link('third-party-licenses.txt', t('third-party licenses')),
  }),
);
const about = mountAbout($<HTMLDialogElement>('#about'));
for (const id of ['#about-open', '#brand-about']) {
  $(id).addEventListener('click', () => {
    setSheet(false);
    about.open();
  });
}

// Buttons hand focus back to the pattern, so Space and Enter never press them twice.
document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('.btn');
  if (button && !(button.closest('dialog'))) patternEl.focus({ preventScroll: true });
});

// On phones the panels above sit in a sheet behind the Menu button; its tabs pick one.
for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab-target]')) {
  tab.setAttribute('aria-selected', String(tab.dataset.tabTarget === app.dataset.tab));
  tab.addEventListener('click', () => {
    app.dataset.tab = tab.dataset.tabTarget!;
    for (const other of document.querySelectorAll('[data-tab-target]')) {
      other.setAttribute('aria-selected', String(other === tab));
    }
  });
}

const sheet = $('#sheet');
const menuButton = $('#bar-menu');
function setSheet(open: boolean): void {
  app.classList.toggle('sheet-open', open);
  menuButton.setAttribute('aria-expanded', String(open));
  if (open) sheet.scrollTop = 0;
}
menuButton.addEventListener('click', () => setSheet(!app.classList.contains('sheet-open')));
$('#sheet-backdrop').addEventListener('click', () => setSheet(false));
// Transport buttons start something (playback, a dialog, a file picker), so the sheet gets out of the way.
$('.transport').addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('.btn')) setSheet(false);
});

// Phone-only buttons stand in for controls that are hidden on phones.
for (const button of document.querySelectorAll<HTMLElement>('[data-proxy]')) {
  button.addEventListener('click', () => $(`#${button.dataset.proxy}`).click());
}
for (const button of document.querySelectorAll<HTMLElement>('[data-proxy-step]')) {
  const [key, delta] = button.dataset.proxyStep!.split(':') as [keyof typeof limits, string];
  button.addEventListener('click', () => step(key, Number(delta)));
}
$('#bar-play').addEventListener('click', () => {
  if (playing) stop();
  else void play(false);
});

// The piano shows by default on touch screens; the Keys button flips that.
const keysToggle = $<HTMLButtonElement>('#keys-toggle');
const coarse = matchMedia('(pointer: coarse)');
const syncKeysToggle = (): void => {
  const visible = app.classList.contains('show-piano') || (coarse.matches && !app.classList.contains('hide-piano'));
  keysToggle.setAttribute('aria-pressed', String(visible));
  $('#keys-proxy').setAttribute('aria-pressed', String(visible));
  showEntryPad();
};
coarse.addEventListener('change', syncKeysToggle);
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
setOctave(settings.octave);

// ---- Keyboard ------------------------------------------------------------

const KEY_OFF_KEYS = new Set(['Digit1', 'Backquote', 'IntlBackslash']);
const heldKeys = new Map<string, number>();

/** Ctrl/Cmd shortcuts. Returns true when the key was handled. */
function handleCommand(event: KeyboardEvent): boolean {
  switch (event.code) {
    case 'KeyZ': {
      const label = event.shiftKey ? editor.redo() : editor.undo();
      if (event.shiftKey) status.textContent = label ? t('Redo: {edit}', { edit: editName(label) }) : t('Nothing to redo.');
      else status.textContent = label ? t('Undo: {edit}', { edit: editName(label) }) : t('Nothing to undo.');
      return true;
    }
    case 'KeyY': {
      const label = editor.redo();
      status.textContent = label ? t('Redo: {edit}', { edit: editName(label) }) : t('Nothing to redo.');
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
      status.textContent = followSong ? t('Follow song on.') : t('Follow song off: the cursor stays put while the song plays.');
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

  if (event.altKey && !event.ctrlKey && !event.shiftKey && (event.code === 'PageUp' || event.code === 'PageDown')) {
    event.preventDefault();
    if (tabs.length > 1) void switchTab((activeTab + (event.code === 'PageDown' ? 1 : tabs.length - 1)) % tabs.length);
    return;
  }
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
      setSheet(false);
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
      if (event.altKey) void playRow();
      else void play(event.shiftKey);
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
  status.textContent = t('{note}  Instr {instrument}', { note: noteName(note), instrument: hex(instrument) });
}

window.addEventListener('keyup', (event) => {
  const note = heldKeys.get(event.code);
  if (note === undefined) return;
  heldKeys.delete(event.code);
  previewOff(note);
});

view.onCursor = () => {
  status.textContent = t('Row {row}  Channel {channel}', { row: hex(view.row), channel: view.channel + 1 });
};

// ---- Setup: colours, mixer, highlights, keys, MIDI -----------------------

const setup = $<HTMLDialogElement>('#setup');
const themeSelect = $<HTMLSelectElement>('#set-theme');
themeSelect.replaceChildren(
  ...Object.entries(THEMES).map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: t(label) })),
);
$('#set-ui-size').replaceChildren(
  ...Object.entries(UI_SIZES).map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: t(label) })),
);
// Language names stay in their own language, so everyone finds theirs.
$('#set-language').replaceChildren(
  Object.assign(document.createElement('option'), { value: 'auto', textContent: t('Auto (browser language)') }),
  ...Object.entries(LANGUAGES).map(([value, { name }]) => Object.assign(document.createElement('option'), { value, textContent: name })),
);
const checkbox = (id: string) => $<HTMLInputElement>(id);

function mixerMessage(): EngineMessage {
  return {
    type: 'mixer',
    resampler: prefs.resampler,
    stereoSeparation: prefs.stereoSeparation,
    volumeRamps: prefs.volumeRamps,
    amplify: prefs.amplify,
    karplusStrong: prefs.karplusStrong,
  };
}

// ---- Colour scheme editor -------------------------------------------------

const colourInputs = new Map<string, HTMLInputElement>();
$('#colour-grid').replaceChildren(
  ...COLOR_VARS.map(([name, label]) => {
    const row = document.createElement('label');
    const input = Object.assign(document.createElement('input'), { type: 'color', title: name });
    input.addEventListener('input', () => {
      prefs.colors[name] = input.value;
      saveSettings(prefs);
      applySettings();
    });
    // The setup dialog's change handler would otherwise re-apply everything for each colour.
    input.addEventListener('change', (event) => event.stopPropagation());
    colourInputs.set(name, input);
    row.append(input, Object.assign(document.createElement('span'), { className: 'label', textContent: t(label) }));
    return row;
  }),
);

/** Any CSS colour as #rrggbb, which colour inputs need. */
function hexColour(css: string): string {
  const g = document.createElement('canvas').getContext('2d');
  if (!g) return '#000000';
  g.fillStyle = '#000000';
  g.fillStyle = css;
  return /^#[0-9a-f]{6}$/i.test(g.fillStyle) ? g.fillStyle : '#000000';
}

function applyColours(): void {
  const root = document.documentElement.style;
  for (const [name] of COLOR_VARS) {
    const value = prefs.colors[name];
    if (value) root.setProperty(name, value);
    else root.removeProperty(name);
  }
}

function showColours(): void {
  const style = getComputedStyle(document.documentElement);
  for (const [name, input] of colourInputs) input.value = hexColour(style.getPropertyValue(name).trim());
}

$('#colours-reset').addEventListener('click', () => {
  prefs.colors = {};
  saveSettings(prefs);
  applySettings();
  showColours();
  status.textContent = t('Colours reset to the scheme.');
});

$('#colours-export').addEventListener('click', () => {
  const style = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(COLOR_VARS.map(([name]) => [name, hexColour(style.getPropertyValue(name).trim())]));
  download(new TextEncoder().encode(JSON.stringify({ theme: prefs.theme, colors }, null, 2)), 'colours.json', 'application/json');
});

const colourFile = $<HTMLInputElement>('#colours-file');
$('#colours-import').addEventListener('click', () => colourFile.click());
colourFile.addEventListener('change', async (event) => {
  event.stopPropagation();
  const file = colourFile.files?.[0];
  colourFile.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text()) as { theme?: unknown; colors?: unknown };
    if (typeof data.theme === 'string' && data.theme in THEMES) prefs.theme = data.theme as Theme;
    prefs.colors = parseColors(data.colors);
    saveSettings(prefs);
    applySettings();
    showSettings();
    status.textContent = t('Loaded colours from {file}.', { file: file.name });
  } catch {
    status.textContent = t('{file} is not a colour file.', { file: file.name });
    void tell(status.textContent, t('Colours'));
  }
});

// Phones keep the sizes from the stylesheet; bigger screens get Setup's size.
const phoneLayout = matchMedia('(max-width: 639px), (max-height: 500px) and (orientation: landscape)');
const coarsePointer = matchMedia('(pointer: coarse)');

function applyUiSize(): void {
  const root = document.documentElement.style;
  if (phoneLayout.matches) root.removeProperty('--px');
  else root.setProperty('--px', `${uiPixel(prefs.uiSize, coarsePointer.matches, devicePixelRatio, innerWidth)}px`);
}

// Browser zoom changes the device pixel ratio and fires resize.
for (const query of [phoneLayout, coarsePointer]) query.addEventListener('change', applyUiSize);
addEventListener('resize', applyUiSize);

function applySettings(): void {
  document.documentElement.dataset.theme = prefs.theme;
  applyUiSize();
  applyColours();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--desk').trim());
  view.beat = prefs.beat;
  view.bar = prefs.bar;
  view.prospective = prefs.prospective;
  view.wrap = prefs.wrapCursor;
  view.render();
  engine?.send(mixerMessage());
  scopesDirty = true;
  renderEditors();
  void connectMidi(prefs.midi);
}

function showSettings(): void {
  $<HTMLSelectElement>('#set-language').value = prefs.language in LANGUAGES ? prefs.language : 'auto';
  themeSelect.value = prefs.theme;
  $<HTMLSelectElement>('#set-ui-size').value = prefs.uiSize;
  $<HTMLSelectElement>('#set-resampler').value = prefs.resampler;
  $<HTMLInputElement>('#set-separation').value = String(prefs.stereoSeparation);
  $('#set-separation-value').textContent = `${prefs.stereoSeparation}%`;
  checkbox('#set-ramps').checked = prefs.volumeRamps;
  $<HTMLInputElement>('#set-amplify').value = String(prefs.amplify);
  $('#set-amplify-value').textContent = `${prefs.amplify}%`;
  showColours();
  checkbox('#set-karplus').checked = prefs.karplusStrong;
  $<HTMLSelectElement>('#set-beat').value = String(prefs.beat);
  $<HTMLSelectElement>('#set-bar').value = String(prefs.bar);
  $<HTMLSelectElement>('#set-space').value = prefs.space;
  checkbox('#set-midi').checked = prefs.midi;
  checkbox('#set-velocity').checked = prefs.midiVelocity;
  checkbox('#set-tabs').checked = prefs.songTabs;
  checkbox('#set-prospective').checked = prefs.prospective;
  checkbox('#set-wrap').checked = prefs.wrapCursor;
  $<HTMLSelectElement>('#set-raw').value = prefs.rawFormat;
}

setup.addEventListener('change', () => {
  prefs.theme = themeSelect.value as Theme;
  prefs.uiSize = $<HTMLSelectElement>('#set-ui-size').value as UiSize;
  prefs.resampler = $<HTMLSelectElement>('#set-resampler').value as Resampler;
  prefs.stereoSeparation = Number($<HTMLInputElement>('#set-separation').value);
  $('#set-separation-value').textContent = `${prefs.stereoSeparation}%`;
  prefs.volumeRamps = checkbox('#set-ramps').checked;
  prefs.amplify = Number($<HTMLInputElement>('#set-amplify').value);
  $('#set-amplify-value').textContent = `${prefs.amplify}%`;
  prefs.karplusStrong = checkbox('#set-karplus').checked;
  prefs.beat = Number($<HTMLSelectElement>('#set-beat').value);
  prefs.bar = Number($<HTMLSelectElement>('#set-bar').value);
  prefs.space = $<HTMLSelectElement>('#set-space').value as Settings['space'];
  prefs.midi = checkbox('#set-midi').checked;
  prefs.midiVelocity = checkbox('#set-velocity').checked;
  prefs.songTabs = checkbox('#set-tabs').checked;
  prefs.prospective = checkbox('#set-prospective').checked;
  prefs.wrapCursor = checkbox('#set-wrap').checked;
  prefs.rawFormat = $<HTMLSelectElement>('#set-raw').value as RawFormat;
  saveSettings(prefs);
  applySettings();
  showColours();
});
// A new language takes a reload: texts are put in place once, as the page starts.
$('#set-language').addEventListener('change', async (event) => {
  event.stopPropagation();
  const select = event.target as HTMLSelectElement;
  prefs.language = select.value;
  saveSettings(prefs);
  if (!(await ask(t('The new language shows after a reload. Your song is kept, but other open song tabs and the undo history are not. Reload now?'), { title: t('Language'), ok: t('Reload'), cancel: t('Later') }))) return;
  await autosaveNow();
  reloading = true;
  location.reload();
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
    info.textContent = t('This browser has no Web MIDI.');
    return;
  }
  try {
    midiAccess ??= await navigator.requestMIDIAccess();
    midiAccess.onstatechange = listenToInputs;
    listenToInputs();
    const names = [...midiAccess.inputs.values()].map((i) => i.name ?? t('MIDI input'));
    info.textContent = names.length ? `MIDI: ${names.join(', ')}` : t('MIDI is on; no input device connected yet.');
  } catch (error) {
    info.textContent = t('MIDI not allowed: {error}', { error: (error as Error).message });
  }
}

applySettings();
showSong();
void startUp().then(() => {
  if (!shouldShow(readSeen(), returning)) {
    if (!returning) markSeen();
    return;
  }
  // A link that opened a dialog of its own (a jam or a transfer) goes first; this waits for the next visit.
  if (!document.querySelector('dialog[open]')) whatsNew.open();
});

// Offline use: the service worker exists only in the build.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Without it the tracker still works online.
  });
}
