// Small DOM helpers for the editor panels, in the look of style.css.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function button(text: string, onClick: (event: MouseEvent) => void, title = ''): HTMLButtonElement {
  const b = el('button', 'btn sm', text);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export function toggle(text: string, onClick: () => void, title = ''): HTMLButtonElement {
  const b = button(text, onClick, title);
  b.setAttribute('aria-pressed', 'false');
  return b;
}

export function setPressed(b: HTMLButtonElement, on: boolean): void {
  b.setAttribute('aria-pressed', String(on));
}

export interface Stepper {
  root: HTMLElement;
  output: HTMLOutputElement;
  show(value: number): void;
}

/**
 * A label, a value and −/+ buttons. `step` is called with the delta;
 * Shift multiplies it by `bigStep`.
 */
export function stepper(label: string, step: (delta: number) => void, format: (v: number) => string, bigStep = 16): Stepper {
  const root = el('span', 'stepper');
  const output = el('output', 'value');
  root.append(
    el('span', 'label', label),
    output,
    button('-', (e) => step(e.shiftKey ? -bigStep : -1), `Shift: ${bigStep}`),
    button('+', (e) => step(e.shiftKey ? bigStep : 1), `Shift: ${bigStep}`),
  );
  return { root, output, show: (v) => (output.textContent = format(v)) };
}

export function textInput(label: string, maxLength: number, onChange: (value: string) => void): { root: HTMLElement; input: HTMLInputElement } {
  const root = el('label', 'text-field');
  const input = el('input', 'value text');
  input.type = 'text';
  input.maxLength = maxLength;
  input.spellcheck = false;
  input.addEventListener('change', () => onChange(input.value));
  // Enter or Escape leave the field so the tracker keys work again.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') input.blur();
  });
  root.append(el('span', 'label', label), input);
  return { root, input };
}

/** Sizes a canvas to its CSS box at device resolution and returns the 2D context. */
export function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext('2d');
}

/** Reads a CSS custom property from the root, for canvas colours that follow the theme. */
export function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
