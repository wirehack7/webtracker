import { noteName, type Envelope, type Instrument, type VoiceState } from '@webtracker/engine';
import type { SongEditor } from '../editor/song-editor.ts';
import { hex } from './pattern-view.ts';
import { button, cssColor, drawMarkers, el, fitCanvas, layeredCanvas, setPressed, stepper, textInput, toggle, type Stepper } from './widgets.ts';

export interface InstrumentEditorHost {
  editor: SongEditor;
  instrumentIndex(): number;
  sampleIndex(): number;
  status(text: string): void;
  importFile(): void;
  saveInstrument(): void;
}

type EnvelopeKey = 'volumeEnvelope' | 'panningEnvelope';
const MAX_POINTS = 12;
const VIBRATO_TYPES = ['Sine', 'Square', 'RampDn', 'RampUp'];

/** One envelope: a canvas with draggable points and its On/Sus/Loop controls. */
class EnvelopeView {
  readonly root = el('div', 'envelope');
  private readonly layers = layeredCanvas('env');
  private readonly canvas = this.layers.base;
  private ticks: number[] = [];
  private readonly on: HTMLButtonElement;
  private readonly sus: HTMLButtonElement;
  private readonly loop: HTMLButtonElement;
  private readonly info = el('span', 'info');
  private selected = 0;
  private drag: { point: number; before: Instrument } | null = null;

  constructor(
    private readonly host: InstrumentEditorHost,
    private readonly key: EnvelopeKey,
    title: string,
  ) {
    this.on = toggle('On', () => this.edit('envelope on', (e) => (e.enabled = !e.enabled && e.points.length > 0)));
    this.sus = toggle('Sus', () => this.edit('sustain', (e) => (e.sustain = !e.sustain)));
    this.loop = toggle('Loop', () => this.edit('envelope loop', (e) => (e.loop = !e.loop)));
    const row = el('div', 'tool-row');
    row.append(
      el('span', 'label', title),
      this.on,
      this.sus,
      this.loop,
      button('Sus=Pt', () => this.edit('sustain point', (e) => (e.sustainPoint = this.selected)), 'Sustain at the selected point'),
      button('LpS=Pt', () => this.edit('loop start', (e) => (e.loopStart = Math.min(this.selected, e.loopEnd))), 'Loop starts at the selected point'),
      button('LpE=Pt', () => this.edit('loop end', (e) => (e.loopEnd = Math.max(this.selected, e.loopStart))), 'Loop ends at the selected point'),
      button('DelPt', () => this.deletePoint(this.selected), 'Delete the selected point (or right-click it)'),
      this.info,
    );
    this.root.append(row, this.layers.root);
    this.bind();
    new ResizeObserver(() => {
      this.draw();
      this.drawTicks();
    }).observe(this.canvas);
  }

  /** Marks the envelope positions of the voices playing this instrument. */
  showTicks(ticks: number[]): void {
    this.ticks = ticks;
    this.drawTicks();
  }

  private drawTicks(): void {
    const env = this.envelope();
    const span = env ? this.span(env) : 1;
    drawMarkers(this.layers.overlay, env?.enabled ? this.ticks.map((t) => t / span) : []);
  }

  private envelope(): Envelope | null {
    return this.host.editor.song.instruments[this.host.instrumentIndex()]?.[this.key] ?? null;
  }

  private edit(label: string, fn: (env: Envelope) => void): void {
    this.host.editor.editInstrument(this.host.instrumentIndex(), label, (ins) => fn(ins[this.key]));
  }

  /** Ticks shown across the canvas: a bit more than the last point. */
  private span(env: Envelope): number {
    const last = env.points.at(-1)?.x ?? 0;
    return Math.max(64, Math.ceil((last + 16) / 32) * 32);
  }

  private toPoint(env: Envelope, clientX: number, clientY: number): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    const x = Math.round(((clientX - box.left) / Math.max(1, box.width)) * this.span(env));
    const y = Math.round((1 - (clientY - box.top) / Math.max(1, box.height)) * 64);
    return { x: Math.max(0, x), y: Math.max(0, Math.min(64, y)) };
  }

  private pointAt(env: Envelope, clientX: number, clientY: number): number {
    const box = this.canvas.getBoundingClientRect();
    const span = this.span(env);
    return env.points.findIndex((p) => {
      const px = box.left + (p.x / span) * box.width;
      const py = box.top + (1 - p.y / 64) * box.height;
      return Math.abs(px - clientX) <= 7 && Math.abs(py - clientY) <= 7;
    });
  }

  private deletePoint(index: number): void {
    this.edit('delete point', (e) => {
      if (index < 0 || index >= e.points.length || (index === 0 && e.points.length > 1)) return;
      e.points.splice(index, 1);
      const fix = (i: number) => Math.max(0, Math.min(e.points.length - 1, i > index ? i - 1 : i));
      e.sustainPoint = fix(e.sustainPoint);
      e.loopStart = fix(e.loopStart);
      e.loopEnd = fix(e.loopEnd);
      if (e.points.length === 0) e.enabled = false;
    });
    this.selected = Math.max(0, index - 1);
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (event) => {
      const env = this.envelope();
      if (!env) return;
      event.preventDefault();
      const hit = this.pointAt(env, event.clientX, event.clientY);
      if (hit >= 0) this.deletePoint(hit);
    });
    c.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const index = this.host.instrumentIndex();
      const before = this.host.editor.snapshotInstrument(index);
      const env = this.host.editor.song.instruments[index]![this.key];
      let hit = this.pointAt(env, event.clientX, event.clientY);
      if (hit < 0) {
        if (env.points.length >= MAX_POINTS) return;
        // A click on empty space adds a point there, in tick order.
        const p = this.toPoint(env, event.clientX, event.clientY);
        if (env.points.length === 0) p.x = 0;
        hit = env.points.findIndex((q) => q.x > p.x);
        if (hit < 0) hit = env.points.length;
        if (hit === 0 && env.points.length > 0) return;
        if (env.points.some((q) => q.x === p.x)) return;
        env.points.splice(hit, 0, p);
        const shift = (i: number) => (i >= hit && env.points.length > 1 ? i + 1 : i);
        env.sustainPoint = shift(env.sustainPoint);
        env.loopStart = shift(env.loopStart);
        env.loopEnd = shift(env.loopEnd);
        if (env.points.length === 1) env.enabled = true;
        this.host.editor.previewInstrument(index);
      }
      this.selected = hit;
      this.drag = { point: hit, before };
      c.setPointerCapture(event.pointerId);
      this.render();
    });
    c.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      const env = this.envelope();
      if (!drag || !env) return;
      const p = env.points[drag.point];
      if (!p) return;
      const to = this.toPoint(env, event.clientX, event.clientY);
      // The first point stays at tick 0, the others stay between their neighbours.
      const prev = env.points[drag.point - 1];
      const next = env.points[drag.point + 1];
      p.x = drag.point === 0 ? 0 : Math.max((prev?.x ?? 0) + 1, Math.min(next ? next.x - 1 : 0xffff, to.x));
      p.y = to.y;
      this.host.editor.previewInstrument(this.host.instrumentIndex());
      this.render();
    });
    const finish = () => {
      const drag = this.drag;
      this.drag = null;
      if (drag) this.host.editor.recordInstrument(this.host.instrumentIndex(), 'envelope', drag.before);
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
  }

  render(): void {
    const env = this.envelope();
    setPressed(this.on, !!env?.enabled);
    setPressed(this.sus, !!env?.sustain);
    setPressed(this.loop, !!env?.loop);
    const n = env?.points.length ?? 0;
    this.selected = Math.min(this.selected, Math.max(0, n - 1));
    const p = env?.points[this.selected];
    this.info.textContent = p ? `Pt ${this.selected + 1}/${n}  X ${p.x}  Y ${hex(p.y)}` : 'Click to add points';
    this.draw();
    this.drawTicks();
  }

  private draw(): void {
    const env = this.envelope();
    const g = fitCanvas(this.canvas);
    if (!g) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.fillStyle = cssColor('--pat-bg', '#000');
    g.fillRect(0, 0, w, h);
    if (!env) return;
    const span = this.span(env);
    const X = (x: number) => (x / span) * (w - 1);
    const Y = (y: number) => (1 - y / 64) * (h - 1);

    g.fillStyle = cssColor('--pat-sep', '#22304a');
    for (let t = 0; t <= span; t += 16) g.fillRect(Math.round(X(t)), 0, 1, h);

    const pts = env.points;
    const mark = (i: number, colour: string) => {
      const q = pts[i];
      if (!q) return;
      g.fillStyle = colour;
      g.fillRect(Math.round(X(q.x)), 0, 1, h);
    };
    if (env.loop) {
      mark(env.loopStart, cssColor('--pat-fx', '#ff8fdf'));
      mark(env.loopEnd, cssColor('--pat-fx', '#ff8fdf'));
    }
    if (env.sustain) mark(env.sustainPoint, cssColor('--pat-cell', '#ffd84a'));

    g.strokeStyle = env.enabled ? cssColor('--pat-vol', '#7fff8f') : cssColor('--pat-empty', '#3a4660');
    g.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    g.beginPath();
    pts.forEach((q, i) => (i === 0 ? g.moveTo(X(q.x), Y(q.y)) : g.lineTo(X(q.x), Y(q.y))));
    g.stroke();
    const size = Math.round(4 * (window.devicePixelRatio || 1));
    pts.forEach((q, i) => {
      g.fillStyle = i === this.selected ? '#ffffff' : cssColor('--pat-instr', '#7fdfff');
      g.fillRect(Math.round(X(q.x) - size / 2), Math.round(Y(q.y) - size / 2), size, size);
    });
  }
}

/** Instrument settings: name, envelopes, fadeout, auto-vibrato and the keymap. */
export class InstrumentEditor {
  readonly root = el('div', 'editor-view instrument-editor');
  private readonly name;
  private readonly envelopes: EnvelopeView[];
  private readonly fadeout: Stepper;
  private readonly vibrato: Record<'vibratoSweep' | 'vibratoDepth' | 'vibratoRate', Stepper>;
  private readonly vibratoType: HTMLButtonElement;
  private readonly keymap = el('div', 'keymap');
  private readonly keys: HTMLButtonElement[] = [];

  constructor(private readonly host: InstrumentEditorHost) {
    this.name = textInput('Name', 22, (value) => this.edit('name', (ins) => (ins.name = value)));
    this.envelopes = [new EnvelopeView(host, 'volumeEnvelope', 'Volume'), new EnvelopeView(host, 'panningEnvelope', 'Panning')];
    this.fadeout = stepper('Fadeout', (d) => this.edit('fadeout', (ins) => (ins.fadeout = Math.max(0, Math.min(0xfff, ins.fadeout + d)))), (v) => hex(v, 3), 256);
    const vib = (key: 'vibratoSweep' | 'vibratoDepth' | 'vibratoRate', label: string, max: number) =>
      stepper(label, (d) => this.edit('vibrato', (ins) => (ins[key] = Math.max(0, Math.min(max, ins[key] + d)))), (v) => hex(v), 16);
    this.vibrato = { vibratoSweep: vib('vibratoSweep', 'Sweep', 255), vibratoDepth: vib('vibratoDepth', 'Depth', 15), vibratoRate: vib('vibratoRate', 'Rate', 63) };
    this.vibratoType = button('Sine', () => this.edit('vibrato', (ins) => (ins.vibratoType = (ins.vibratoType + 1) % 4)), 'Auto-vibrato waveform');

    const top = el('div', 'tool-row');
    top.append(
      this.name.root,
      button('Load', () => host.importFile(), 'Load an XI instrument, or a sample into the current slot'),
      button('Save XI', () => host.saveInstrument(), 'Save this instrument as XI'),
      this.fadeout.root,
      el('span', 'label', 'Vibrato'),
      this.vibratoType,
      ...Object.values(this.vibrato).map((s) => s.root),
    );

    for (let k = 0; k < 96; k++) {
      const key = el('button', `km${[1, 3, 6, 8, 10].includes(k % 12) ? ' black' : ''}`);
      key.type = 'button';
      key.title = noteName(k + 1);
      key.addEventListener('click', () => this.assign(k, k));
      this.keys.push(key);
    }
    const keyRow = el('div', 'tool-row');
    keyRow.append(
      el('span', 'label', 'Keymap'),
      button('All', () => this.assign(0, 95), 'Map every note to the selected sample'),
      el('span', 'info', 'Click a key to play the selected sample there'),
    );
    this.keymap.append(...this.keys);
    this.root.append(top, ...this.envelopes.map((e) => e.root), keyRow, this.keymap);
  }

  /** Play markers for every voice on this instrument: envelope positions and the keys held. */
  showVoices(voices: VoiceState[]): void {
    const ins = this.host.instrumentIndex() + 1;
    const mine = voices.filter((v) => v.instrument === ins);
    this.envelopes[0]!.showTicks(mine.map((v) => v.volEnvTick));
    this.envelopes[1]!.showTicks(mine.map((v) => v.panEnvTick));
    const notes = new Set(mine.map((v) => v.note - 1));
    this.keys.forEach((key, k) => key.classList.toggle('playing', notes.has(k)));
  }

  private edit(label: string, fn: (ins: Instrument) => void): void {
    this.host.editor.editInstrument(this.host.instrumentIndex(), label, fn);
  }

  private assign(from: number, to: number): void {
    const sample = this.host.sampleIndex();
    this.edit('keymap', (ins) => ins.keymap.fill(sample, from, to + 1));
  }

  render(): void {
    const ins = this.host.editor.song.instruments[this.host.instrumentIndex()];
    this.name.input.value = ins?.name ?? '';
    for (const e of this.envelopes) e.render();
    this.fadeout.show(ins?.fadeout ?? 0);
    for (const [key, s] of Object.entries(this.vibrato) as [keyof typeof this.vibrato, Stepper][]) s.show(ins?.[key] ?? 0);
    this.vibratoType.textContent = VIBRATO_TYPES[ins?.vibratoType ?? 0] ?? 'Sine';
    const samples = ins?.samples.length ?? 0;
    this.keys.forEach((key, k) => {
      const s = ins?.keymap[k] ?? 0;
      key.textContent = hex(s, 1);
      key.classList.toggle('missing', s >= samples);
      key.classList.toggle('current', s === this.host.sampleIndex());
    });
  }
}
