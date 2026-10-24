// On-screen keyboard for touch and mouse. Two octaves starting at the current
// octave; reports semitone offsets so the caller applies the octave.

const BLACK = new Set([1, 3, 6, 8, 10]);
const LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface PianoHandlers {
  down(semitone: number): void;
  up(semitone: number): void;
}

export function mountPiano(container: HTMLElement, octaves: number, handlers: PianoHandlers): void {
  const whiteCount = octaves * 7;
  const keys: HTMLButtonElement[] = [];
  let white = 0;
  for (let s = 0; s < octaves * 12; s++) {
    const key = document.createElement('button');
    key.type = 'button';
    key.tabIndex = -1;
    key.dataset.semitone = String(s);
    const black = BLACK.has(s % 12);
    key.className = black ? 'key black' : 'key white';
    const width = 100 / whiteCount;
    if (black) {
      key.style.left = `${(white - 0.3) * width}%`;
      key.style.width = `${width * 0.6}%`;
    } else {
      key.style.left = `${white * width}%`;
      key.style.width = `${width}%`;
      if (s % 12 === 0) key.textContent = LABELS[0] ?? '';
      white++;
    }
    keys.push(key);
  }
  container.replaceChildren(...keys);

  // One active key per pointer, so multi-touch and sliding across keys work.
  const active = new Map<number, number>();
  const keyAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.key');
    return el && container.contains(el) ? Number(el.dataset.semitone) : null;
  };
  const release = (pointer: number): void => {
    const semitone = active.get(pointer);
    if (semitone === undefined) return;
    active.delete(pointer);
    keys[semitone]?.classList.remove('down');
    handlers.up(semitone);
  };
  const press = (pointer: number, semitone: number | null): void => {
    if (active.get(pointer) === semitone) return;
    release(pointer);
    if (semitone === null) return;
    active.set(pointer, semitone);
    keys[semitone]?.classList.add('down');
    handlers.down(semitone);
  };

  container.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    container.setPointerCapture(event.pointerId);
    press(event.pointerId, keyAt(event.clientX, event.clientY));
  });
  container.addEventListener('pointermove', (event) => {
    if (active.has(event.pointerId)) press(event.pointerId, keyAt(event.clientX, event.clientY));
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    container.addEventListener(type, (event) => release(event.pointerId));
  }
}
