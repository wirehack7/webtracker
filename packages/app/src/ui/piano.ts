// On-screen keyboard for touch and mouse. It spans every octave a note can
// be in (C-0 to B-7) and scrolls sideways: swipe the octave strip on top,
// use the arrow buttons, or scroll with a mouse wheel or trackpad. Only part
// of it is visible at a time (2 octaves on a phone, more on wider screens).

const BLACK = new Set([1, 3, 6, 8, 10]);
export const PIANO_OCTAVES = 8;

export interface PianoHandlers {
  /** `note` is the XM note number, 1 = C-0. */
  down(note: number): void;
  up(note: number): void;
  /** The leftmost fully visible octave changed because the user scrolled. */
  scrolled(octave: number): void;
}

export interface Piano {
  /** Scrolls so `octave` is the first one visible. */
  showOctave(octave: number, smooth?: boolean): void;
}

export function mountPiano(container: HTMLElement, handlers: PianoHandlers): Piano {
  const scroller = document.createElement('div');
  scroller.className = 'piano-scroll';
  const inner = document.createElement('div');
  inner.className = 'piano-inner';
  const strip = document.createElement('div');
  strip.className = 'piano-strip';
  const keyArea = document.createElement('div');
  keyArea.className = 'piano-keys';
  inner.append(strip, keyArea);
  scroller.append(inner);

  const arrow = (text: string, delta: number, label: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn piano-arrow';
    b.textContent = text;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => piano.showOctave(firstOctave() + delta, true));
    return b;
  };
  container.replaceChildren(arrow('<', -1, 'Lower octave'), scroller, arrow('>', 1, 'Higher octave'));

  for (let o = 0; o < PIANO_OCTAVES; o++) {
    const label = document.createElement('span');
    label.textContent = `C${o}`;
    strip.append(label);
  }

  const whiteCount = PIANO_OCTAVES * 7;
  const width = 100 / whiteCount;
  const keys: HTMLButtonElement[] = [];
  let white = 0;
  for (let s = 0; s < PIANO_OCTAVES * 12; s++) {
    const key = document.createElement('button');
    key.type = 'button';
    key.tabIndex = -1;
    key.dataset.note = String(s + 1);
    const black = BLACK.has(s % 12);
    key.className = black ? 'key black' : 'key white';
    if (black) {
      key.style.left = `${(white - 0.3) * width}%`;
      key.style.width = `${width * 0.6}%`;
    } else {
      key.style.left = `${white * width}%`;
      key.style.width = `${width}%`;
      if (s % 12 === 0) key.textContent = `C${s / 12}`;
      white++;
    }
    keys.push(key);
  }
  keyArea.replaceChildren(...keys);

  const octaveWidth = () => inner.clientWidth / PIANO_OCTAVES;
  const firstOctave = () => Math.round(scroller.scrollLeft / Math.max(1, octaveWidth()));

  // One active key per pointer, so multi-touch and sliding across keys work.
  // Keys never scroll; only the strip, the arrows and the wheel do.
  const active = new Map<number, number>();
  const keyAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.key');
    return el && keyArea.contains(el) ? Number(el.dataset.note) : null;
  };
  const release = (pointer: number): void => {
    const note = active.get(pointer);
    if (note === undefined) return;
    active.delete(pointer);
    keys[note - 1]?.classList.remove('down');
    handlers.up(note);
  };
  const press = (pointer: number, note: number | null): void => {
    if (active.get(pointer) === note) return;
    release(pointer);
    if (note === null) return;
    active.set(pointer, note);
    keys[note - 1]?.classList.add('down');
    handlers.down(note);
  };

  keyArea.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    keyArea.setPointerCapture(event.pointerId);
    press(event.pointerId, keyAt(event.clientX, event.clientY));
  });
  keyArea.addEventListener('pointermove', (event) => {
    if (active.has(event.pointerId)) press(event.pointerId, keyAt(event.clientX, event.clientY));
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    keyArea.addEventListener(type, (event) => release(event.pointerId));
  }

  // A mouse wheel scrolls sideways, and a mouse can drag the strip like a finger.
  scroller.addEventListener(
    'wheel',
    (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaY;
    },
    { passive: false },
  );
  let dragFrom: { x: number; left: number } | null = null;
  let dragged = false;
  strip.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') return;
    strip.setPointerCapture(event.pointerId);
    dragFrom = { x: event.clientX, left: scroller.scrollLeft };
    dragged = false;
  });
  strip.addEventListener('pointermove', (event) => {
    if (!dragFrom) return;
    const dx = event.clientX - dragFrom.x;
    if (Math.abs(dx) > 4) dragged = true;
    scroller.scrollLeft = dragFrom.left - dx;
  });
  strip.addEventListener('pointerup', () => (dragFrom = null));

  // A tap on the strip jumps to that octave.
  strip.addEventListener('click', (event) => {
    if (dragged) {
      dragged = false;
      return;
    }
    const box = inner.getBoundingClientRect();
    const octave = Math.floor((event.clientX - box.left) / Math.max(1, octaveWidth()));
    piano.showOctave(octave, true);
  });

  // Report scrolling by the user, but not the scrolls showOctave asked for.
  let reported = -1;
  let programmatic = false;
  let settle = 0;
  let wanted = 4;
  scroller.addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = window.setTimeout(() => {
      const octave = Math.max(0, Math.min(PIANO_OCTAVES - 1, firstOctave()));
      if (!programmatic && octave !== reported) handlers.scrolled(octave);
      reported = octave;
      wanted = octave;
      programmatic = false;
    }, 120);
  });

  const piano: Piano = {
    showOctave(octave, smooth = false) {
      wanted = Math.max(0, Math.min(PIANO_OCTAVES - 1, octave));
      const left = wanted * octaveWidth();
      if (Math.abs(scroller.scrollLeft - left) < 1) {
        if (wanted !== reported) handlers.scrolled(wanted);
        reported = wanted;
        return;
      }
      programmatic = !smooth;
      scroller.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    },
  };
  // Keep the same octave in view when the width changes or the piano appears.
  new ResizeObserver(() => scroller.scrollTo({ left: wanted * octaveWidth() })).observe(scroller);
  return piano;
}
