import { noteName, type PlayerState, type Song } from '@webtracker/engine';
import { loadModule } from '@webtracker/formats';
import { EngineNode } from './audio/engine.ts';
import type { WorkletMessage } from './audio/messages.ts';
import { noteForKey, octaveForKey } from './keyboard.ts';
import { highlightRow, renderPattern } from './ui/pattern-view.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>('file');
const playSongButton = $<HTMLButtonElement>('play-song');
const playPatternButton = $<HTMLButtonElement>('play-pattern');
const stopButton = $<HTMLButtonElement>('stop');
const prevButton = $<HTMLButtonElement>('prev-order');
const nextButton = $<HTMLButtonElement>('next-order');
const status = $('status');
const patternView = $('pattern-view');
const meters = $('meters');
const noteLabel = $('note');

let engine: EngineNode | null = null;
let song: Song | null = null;
let state: PlayerState | null = null;
let shownPattern = -1;
let rowElements: HTMLElement[] = [];
let octave = 4;
let heldKey: string | null = null;

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
}

/** Starts audio on the first user gesture and reuses it afterwards. */
async function ensureEngine(): Promise<EngineNode> {
  if (!engine) {
    engine = await EngineNode.start();
    engine.onMessage = handleWorkletMessage;
    if (song) engine.send({ type: 'load', song });
  }
  if (engine.context.state !== 'running') await engine.context.resume();
  return engine;
}

function handleWorkletMessage(message: WorkletMessage): void {
  showState(message.state);
  if (message.type === 'row') showLevels(message.levels);
}

function showSong(s: Song, fileName: string): void {
  $('song-title').textContent = s.title || fileName;
  $('song-format').textContent = s.formatName;
  $('song-channels').textContent = String(s.channels);
  const list = $('instrument-list');
  list.textContent = '';
  for (const ins of s.instruments) {
    const li = document.createElement('li');
    li.textContent = ins.name || ' ';
    li.classList.toggle('empty', ins.samples.length === 0);
    list.appendChild(li);
  }
  meters.textContent = '';
  for (let i = 0; i < s.channels; i++) meters.appendChild(document.createElement('span'));
  shownPattern = -1;
  showState({ order: 0, pattern: s.orders[0] ?? 0, row: 0, speed: s.initialSpeed, tempo: s.initialTempo, playing: false, loops: 0 });
}

function showState(next: PlayerState): void {
  if (!song) return;
  state = next;
  $('song-position').textContent = `Pos ${next.order}/${song.orders.length - 1} · Pat ${next.pattern} · Zeile ${next.row}`;
  $('song-speed').textContent = `${next.speed} / ${next.tempo}`;
  if (next.pattern !== shownPattern) {
    const pattern = song.patterns[next.pattern];
    rowElements = pattern ? renderPattern(patternView, song, pattern, song.format === 'xm') : [];
    shownPattern = next.pattern;
  }
  highlightRow(patternView, rowElements, next.row);
}

function showLevels(levels: number[]): void {
  const bars = meters.children;
  for (let i = 0; i < bars.length; i++) {
    (bars[i] as HTMLElement).style.height = `${Math.min(100, (levels[i] ?? 0) * 100)}%`;
  }
}

async function openFile(file: File): Promise<void> {
  try {
    const loaded = loadModule(await file.arrayBuffer(), file.name);
    song = loaded;
    engine?.send({ type: 'stop' });
    engine?.send({ type: 'load', song: loaded });
    showSong(loaded, file.name);
    for (const b of [playSongButton, playPatternButton, stopButton, prevButton, nextButton]) b.disabled = false;
    setStatus(`${file.name} geladen: ${loaded.patterns.length} Patterns, ${loaded.orders.length} Positionen.`);
  } catch (error) {
    console.error(error);
    setStatus(`${file.name} konnte nicht geladen werden: ${(error as Error).message}`, true);
  }
}

async function play(loopPattern: boolean): Promise<void> {
  try {
    const node = await ensureEngine();
    node.send({ type: 'play', loopPattern });
  } catch (error) {
    setStatus(`Audio konnte nicht starten: ${String(error)}`, true);
  }
}

function seek(order: number): void {
  if (!song || !engine) return;
  engine.send({ type: 'seek', order: Math.max(0, Math.min(song.orders.length - 1, order)) });
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
  fileInput.value = '';
});
playSongButton.addEventListener('click', () => void play(false));
playPatternButton.addEventListener('click', () => void play(true));
stopButton.addEventListener('click', () => engine?.send({ type: 'stop' }));
prevButton.addEventListener('click', () => seek((state?.order ?? 0) - 1));
nextButton.addEventListener('click', () => seek((state?.order ?? 0) + 1));

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});

window.addEventListener('keydown', async (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof HTMLInputElement) return;

  if (event.code === 'Space' && song) {
    event.preventDefault();
    if (state?.playing) engine?.send({ type: 'stop' });
    else void play(false);
    return;
  }

  const newOctave = octaveForKey(event.code);
  if (newOctave !== null) {
    event.preventDefault();
    octave = newOctave;
    setStatus(`Oktave ${octave}.`);
    return;
  }

  const note = noteForKey(event.code, octave);
  if (note === null) return;
  event.preventDefault();
  heldKey = event.code;
  const node = await ensureEngine();
  node.send({ type: 'noteOn', note });
  noteLabel.textContent = noteName(note);
});

window.addEventListener('keyup', (event) => {
  if (!engine || event.code !== heldKey) return;
  heldKey = null;
  engine.send({ type: 'noteOff' });
  noteLabel.textContent = '---';
});
