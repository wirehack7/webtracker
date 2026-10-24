import { noteName } from '@webtracker/engine';
import { EngineNode } from './audio/engine.ts';
import { noteForKey, octaveForKey } from './keyboard.ts';

const startButton = document.querySelector<HTMLButtonElement>('#start')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const noteLabel = document.querySelector<HTMLParagraphElement>('#note')!;

let engine: EngineNode | null = null;
let octave = 4;
let heldKey: string | null = null;

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  try {
    engine = await EngineNode.start();
    status.textContent = `Audio läuft mit ${engine.context.sampleRate} Hz. Oktave ${octave}.`;
    startButton.textContent = 'Audio läuft';
  } catch (error) {
    status.textContent = `Audio konnte nicht starten: ${String(error)}`;
    startButton.disabled = false;
  }
});

window.addEventListener('keydown', (event) => {
  if (!engine || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

  const newOctave = octaveForKey(event.code);
  if (newOctave !== null) {
    event.preventDefault();
    octave = newOctave;
    status.textContent = `Audio läuft mit ${engine.context.sampleRate} Hz. Oktave ${octave}.`;
    return;
  }

  const note = noteForKey(event.code, octave);
  if (note === null) return;
  event.preventDefault();
  heldKey = event.code;
  engine.send({ type: 'noteOn', note });
  noteLabel.textContent = noteName(note);
});

window.addEventListener('keyup', (event) => {
  if (!engine || event.code !== heldKey) return;
  heldKey = null;
  engine.send({ type: 'noteOff' });
  noteLabel.textContent = '---';
});
