/**
 * What happy-dom leaves out for the editors: a 2D canvas context that
 * records what is drawn, layout boxes, pointer capture and ResizeObserver.
 * Call `installDom()` in a beforeEach of a happy-dom test file.
 */
import { vi } from 'vitest';

// happy-dom 20 inserts the nodes of insertAdjacentHTML('afterbegin') in reverse order; browsers keep it.
Element.prototype.insertAdjacentHTML = function (this: Element, position: InsertPosition, html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const nodes = template.content;
  if (position === 'beforebegin') this.before(nodes);
  else if (position === 'afterbegin') this.prepend(nodes);
  else if (position === 'beforeend') this.append(nodes);
  else this.after(nodes);
};

export interface DrawCall {
  op: string;
  args: unknown[];
  /** The fill or stroke style when the call was made. */
  style: unknown;
}

/** A 2D context that records every call; read `calls` to see what was drawn. */
export class RecordingContext {
  calls: DrawCall[] = [];
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  globalAlpha = 1;
  lineWidth = 1;
  font = '';
  textBaseline = 'alphabetic';
  textAlign = 'start';
  imageSmoothingEnabled = true;

  constructor(readonly canvas: HTMLCanvasElement) {}

  private record(op: string, args: unknown[]): void {
    this.calls.push({ op, args, style: op.startsWith('stroke') ? this.strokeStyle : this.fillStyle });
  }

  /** Text drawn with fillText, in order. */
  get texts(): string[] {
    return this.calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
  }

  clear(): void {
    this.calls = [];
  }

  createLinearGradient() {
    return { addColorStop: () => {} };
  }
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  createImageData(w: number, h: number) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  getImageData(_x: number, _y: number, w: number, h: number) {
    return this.createImageData(w, h);
  }
}

for (const op of [
  'fillRect', 'clearRect', 'strokeRect', 'fillText', 'strokeText', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect',
  'fill', 'stroke', 'save', 'restore', 'translate', 'scale', 'setTransform', 'drawImage', 'putImageData', 'setLineDash', 'clip',
]) {
  (RecordingContext.prototype as unknown as Record<string, unknown>)[op] = function (this: RecordingContext, ...args: unknown[]) {
    (this as unknown as { record(op: string, args: unknown[]): void }).record(op, args);
  };
}

const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>();

/** The recording context of a canvas, made on first use like a real one. */
export function contextOf(canvas: HTMLCanvasElement): RecordingContext {
  let ctx = contexts.get(canvas);
  if (!ctx) {
    ctx = new RecordingContext(canvas);
    contexts.set(canvas, ctx);
  }
  return ctx;
}

export let resizeObservers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];

/** Sets the layout box an element reports; happy-dom does no layout. */
export function setBox(element: Element, box: { left?: number; top?: number; width: number; height: number }): void {
  const { left = 0, top = 0, width, height } = box;
  element.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height });
}

export function installDom(): void {
  resizeObservers = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return contextOf(this) as unknown as CanvasRenderingContext2D;
  } as never);
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function (id: number) {
    if (!captured.has(this)) captured.set(this, new Set());
    captured.get(this)!.add(id);
  };
  Element.prototype.releasePointerCapture = function (id: number) {
    captured.get(this)?.delete(id);
  };
  Element.prototype.hasPointerCapture = function (id: number) {
    return captured.get(this)?.has(id) ?? false;
  };
  // happy-dom has no Option constructor.
  vi.stubGlobal(
    'Option',
    class {
      constructor(text = '', value?: string, defaultSelected = false, selected = defaultSelected) {
        const option = document.createElement('option');
        option.textContent = text;
        if (value !== undefined) option.value = value;
        option.defaultSelected = defaultSelected;
        option.selected = selected;
        return option;
      }
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        resizeObservers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

/** Tells every ResizeObserver that its elements changed size. */
export function resizeAll(): void {
  for (const { callback } of resizeObservers) callback([], {} as ResizeObserver);
}

/** A pointer event with the fields the editors read. */
export function pointer(type: string, x: number, y: number, extra: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, ...extra });
}

/**
 * Puts the elements of one of the app's HTML pages into the document, so a
 * test runs against the real markup. `selector` picks what to take from
 * the page's body; without it the whole body is taken.
 */
export async function loadPage(file: 'index.html' | 'manual.html', selector?: string): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  // Tests run from the repository root, where vitest.config.ts is.
  const html = await readFile(`${process.cwd()}/packages/app/${file}`, 'utf8');
  const page = new DOMParser().parseFromString(html, 'text/html');
  for (const script of page.querySelectorAll('script')) script.remove();
  if (selector) document.body.replaceChildren(...[...page.querySelectorAll(selector)].map((n) => document.importNode(n, true)));
  else document.body.replaceChildren(...[...page.body.childNodes].map((n) => document.importNode(n, true)));
  document.head.replaceChildren(...[...page.head.childNodes].map((n) => document.importNode(n, true)));
}
