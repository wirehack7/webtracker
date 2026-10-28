// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, pointer, resizeAll, setBox } from '../test-dom.ts';
import { mountPiano, PIANO_OCTAVES, type Piano } from './piano.ts';

/**
 * The on-screen piano: playing with one or more pointers, sliding across
 * keys, and the ways of moving it sideways. Layout comes from setBox, since
 * happy-dom does none: the keyboard is 800 px wide, 100 px an octave.
 */

let container: HTMLElement;
let piano: Piano;
let played: string[];
let scrolled: number[];

const scroller = () => container.querySelector<HTMLElement>('.piano-scroll')!;
const keyArea = () => container.querySelector<HTMLElement>('.piano-keys')!;
const strip = () => container.querySelector<HTMLElement>('.piano-strip')!;
const key = (note: number) => container.querySelector<HTMLElement>(`[data-note="${note}"]`)!;
/** Points elementFromPoint at the key for `note` (or nothing for null). */
const over = (note: number | null) => (document.elementFromPoint = () => (note === null ? null : key(note)));

beforeEach(() => {
  vi.useFakeTimers();
  installDom();
  played = [];
  scrolled = [];
  container = document.createElement('div');
  document.body.replaceChildren(container);
  piano = mountPiano(container, {
    down: (n) => played.push(`+${n}`),
    up: (n) => played.push(`-${n}`),
    scrolled: (o) => scrolled.push(o),
  });
  setBox(container.querySelector('.piano-inner')!, { width: 800, height: 100 });
  // Scrolling happens at once and tells the listeners, as a browser would after a smooth scroll.
  scroller().scrollTo = ((options: ScrollToOptions) => {
    scroller().scrollLeft = options.left ?? 0;
    scroller().dispatchEvent(new Event('scroll'));
  }) as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('piano', () => {
  it('has every key from C-0 to B-7, white and black, labelled at each C', () => {
    expect(container.querySelectorAll('.key')).toHaveLength(PIANO_OCTAVES * 12);
    expect(container.querySelectorAll('.key.black')).toHaveLength(PIANO_OCTAVES * 5);
    expect(key(1).textContent).toBe('C0');
    expect(key(49).textContent).toBe('C4');
    expect(key(2).className).toBe('key black');
    expect([...strip().children].map((c) => c.textContent)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
  });

  it('plays a key while it is held and slides to the next one', () => {
    over(49);
    keyArea().dispatchEvent(pointer('pointerdown', 10, 10, { pointerType: 'mouse' }));
    expect(key(49).classList.contains('down')).toBe(true);
    over(50);
    keyArea().dispatchEvent(pointer('pointermove', 20, 10, { pointerType: 'mouse' }));
    // Moving within the same key does nothing.
    keyArea().dispatchEvent(pointer('pointermove', 21, 10, { pointerType: 'mouse' }));
    keyArea().dispatchEvent(pointer('pointerup', 21, 10, { pointerType: 'mouse' }));
    expect(played).toEqual(['+49', '-49', '+50', '-50']);
    expect(container.querySelector('.down')).toBeNull();
  });

  it('plays several keys with several fingers', () => {
    over(49);
    keyArea().dispatchEvent(pointer('pointerdown', 10, 10, { pointerId: 1, pointerType: 'touch' }));
    over(53);
    keyArea().dispatchEvent(pointer('pointerdown', 50, 10, { pointerId: 2, pointerType: 'touch' }));
    keyArea().dispatchEvent(pointer('pointercancel', 10, 10, { pointerId: 1 }));
    keyArea().dispatchEvent(pointer('lostpointercapture', 50, 10, { pointerId: 2 }));
    expect(played).toEqual(['+49', '+53', '-49', '-53']);
  });

  it('plays nothing off the keys', () => {
    over(null);
    keyArea().dispatchEvent(pointer('pointerdown', 10, 10, { pointerType: 'mouse' }));
    keyArea().dispatchEvent(pointer('pointerup', 10, 10, { pointerType: 'mouse' }));
    expect(played).toEqual([]);
  });

  it('moves the keyboard when a finger holds a key still and then drags, releasing the note', () => {
    over(49);
    keyArea().dispatchEvent(pointer('pointerdown', 300, 10, { pointerType: 'touch' }));
    vi.advanceTimersByTime(400);
    expect(container.classList.contains('holding')).toBe(true);
    keyArea().dispatchEvent(pointer('pointermove', 250, 10, { pointerType: 'touch' }));
    expect(played).toEqual(['+49', '-49']);
    expect(container.classList.contains('moving')).toBe(true);
    // From there the keyboard follows the finger.
    keyArea().dispatchEvent(pointer('pointermove', 180, 10, { pointerType: 'touch' }));
    expect(scroller().scrollLeft).toBe(70);
    keyArea().dispatchEvent(pointer('pointerup', 180, 10, { pointerType: 'touch' }));
    // Let go, it settles on a whole octave.
    expect(container.classList.contains('moving')).toBe(false);
    expect(scroller().scrollLeft).toBe(100);
  });

  it('does not grab the keyboard when the finger slid before the hold', () => {
    over(49);
    keyArea().dispatchEvent(pointer('pointerdown', 300, 10, { pointerType: 'touch' }));
    over(51);
    keyArea().dispatchEvent(pointer('pointermove', 320, 10, { pointerType: 'touch' }));
    vi.advanceTimersByTime(400);
    expect(container.classList.contains('holding')).toBe(false);
    expect(played).toEqual(['+49', '-49', '+51']);
  });

  it('moves the keyboard with a two-finger swipe', () => {
    over(49);
    keyArea().dispatchEvent(pointer('pointerdown', 300, 10, { pointerId: 1, pointerType: 'touch' }));
    keyArea().dispatchEvent(pointer('pointerdown', 400, 10, { pointerId: 2, pointerType: 'touch' }));
    keyArea().dispatchEvent(pointer('pointermove', 340, 10, { pointerId: 1, pointerType: 'touch' }));
    keyArea().dispatchEvent(pointer('pointermove', 440, 10, { pointerId: 2, pointerType: 'touch' }));
    expect(container.classList.contains('moving')).toBe(true);
    expect(played.at(-1)).toBe('-49');
    // A finger that comes down while it moves plays nothing.
    keyArea().dispatchEvent(pointer('pointerdown', 500, 10, { pointerId: 3, pointerType: 'touch' }));
    expect(played.filter((p) => p.startsWith('+'))).toHaveLength(2);
    for (const id of [1, 2, 3]) keyArea().dispatchEvent(pointer('pointerup', 0, 0, { pointerId: id }));
    expect(container.classList.contains('moving')).toBe(false);
  });

  it('scrolls sideways with a mouse wheel, but leaves sideways wheels to the browser', () => {
    const down = new WheelEvent('wheel', { deltaY: 120, deltaX: 0, cancelable: true });
    scroller().dispatchEvent(down);
    expect(scroller().scrollLeft).toBe(120);
    expect(down.defaultPrevented).toBe(true);
    const side = new WheelEvent('wheel', { deltaY: 0, deltaX: 30, cancelable: true });
    scroller().dispatchEvent(side);
    expect(side.defaultPrevented).toBe(false);
  });

  it('drags the octave strip and jumps to an octave when it is tapped', () => {
    strip().dispatchEvent(pointer('pointerdown', 500, 5));
    strip().dispatchEvent(pointer('pointermove', 330, 5));
    expect(container.classList.contains('moving')).toBe(true);
    expect(scroller().scrollLeft).toBe(170);
    strip().dispatchEvent(pointer('pointerup', 330, 5));
    expect(scroller().scrollLeft).toBe(200);
    // The click that ends a drag is not a tap.
    strip().dispatchEvent(new MouseEvent('click', { clientX: 330 }));
    expect(scroller().scrollLeft).toBe(200);
    strip().dispatchEvent(pointer('pointerdown', 650, 5));
    strip().dispatchEvent(pointer('pointercancel', 650, 5));
    strip().dispatchEvent(new MouseEvent('click', { clientX: 650 }));
    expect(scroller().scrollLeft).toBe(600);
  });

  it('reports octaves the user scrolled to, and not those it was told to show', () => {
    piano.showOctave(3);
    vi.advanceTimersByTime(200);
    expect(scrolled).toEqual([]);
    scroller().scrollLeft = 510;
    scroller().dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(200);
    expect(scrolled).toEqual([5]);
    // Asked for the octave it already shows, it says so at once.
    piano.showOctave(5);
    expect(scrolled).toEqual([5]);
    scroller().scrollLeft = 200;
    piano.showOctave(2);
    expect(scrolled).toEqual([5, 2]);
  });

  it('moves an octave with the arrow buttons, within the keyboard', () => {
    piano.showOctave(0);
    const [lower, higher] = container.querySelectorAll<HTMLButtonElement>('.piano-arrow');
    higher!.click();
    expect(scroller().scrollLeft).toBe(100);
    lower!.click();
    lower!.click();
    expect(scroller().scrollLeft).toBe(0);
    piano.showOctave(99);
    expect(scroller().scrollLeft).toBe(700);
  });

  it('keeps its octave in view when its size changes', () => {
    piano.showOctave(4);
    setBox(container.querySelector('.piano-inner')!, { width: 1600, height: 100 });
    resizeAll();
    expect(scroller().scrollLeft).toBe(800);
  });
});
