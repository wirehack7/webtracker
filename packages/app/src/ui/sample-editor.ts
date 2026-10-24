import {
  amplifyRange,
  copyRange,
  crossfadeLoop,
  cropRange,
  deleteRange,
  emptySample,
  fadeIn,
  fadeOut,
  filterRange,
  fixLoop,
  generateWave,
  insertFrames,
  invertRange,
  LoopType,
  normalizeRange,
  quantize8,
  rateForTuning,
  removeDcRange,
  resample,
  reverseRange,
  silenceRange,
  swapBytesRange,
  toggleSignRange,
  tuningForRate,
  WAVE_SHAPES,
  type Range,
  type Sample,
  type VoiceState,
  type WaveShape,
} from '@webtracker/engine';
import type { SongEditor } from '../editor/song-editor.ts';
import { hex } from './pattern-view.ts';
import { button, cssColor, drawMarkers, el, fitCanvas, layeredCanvas, setPressed, stepper, textInput, toggle, type Stepper } from './widgets.ts';

export interface SampleEditorHost {
  editor: SongEditor;
  /** 0-based instrument and sample being edited. */
  instrumentIndex(): number;
  sampleIndex(): number;
  status(text: string): void;
  /** Opens the file picker that imports into the current sample slot. */
  importFile(): void;
  /** Downloads the current sample as a WAV file. */
  saveSample(): void;
}

const WAVE_LABELS: Record<WaveShape, string> = {
  square: 'Sqr',
  pulse25: 'P25',
  pulse12: 'P12',
  triangle: 'Tri',
  saw: 'Saw',
  sine: 'Sin',
  noise: 'Nse',
};
const WAVE_LENGTHS = [16, 32, 64, 128, 256, 1024];

/** Waveform view with selection, loop markers and the FT2-style tools. */
export class SampleEditor {
  readonly root = el('div', 'editor-view sample-editor');
  private readonly layers = layeredCanvas('wave');
  private readonly canvas = this.layers.base;
  private voices: VoiceState[] = [];
  private readonly name;
  private readonly fields: Record<'volume' | 'panning' | 'finetune' | 'relativeNote', Stepper>;
  private readonly loopButtons: HTMLButtonElement[];
  private readonly info = el('span', 'info');
  private readonly waveLength: Stepper;
  /** Selected frames; start === end is a cursor where paste inserts. */
  private selection: Range | null = null;
  /** Visible frames, null = whole sample. */
  private zoom: Range | null = null;
  private clipboard: Float32Array | null = null;
  private waveLengthIndex = 1;
  private drag: { kind: 'select' | 'loopStart' | 'loopEnd'; anchor: number; before: ReturnType<SongEditor['snapshotInstrument']> | null } | null = null;

  constructor(private readonly host: SampleEditorHost) {
    this.name = textInput('Name', 22, (value) => this.edit('name', (s) => (s.name = value)));
    const signed = (v: number) => (v < 0 ? '-' : '+') + hex(Math.abs(v));
    this.fields = {
      volume: stepper('Vol', (d) => this.nudge('volume', d, 0, 64), (v) => hex(v)),
      panning: stepper('Pan', (d) => this.nudge('panning', d, 0, 255), (v) => hex(v)),
      finetune: stepper('Fine', (d) => this.nudge('finetune', d, -128, 127), signed),
      relativeNote: stepper('Rel', (d) => this.nudge('relativeNote', d, -96, 95), (v) => (v < 0 ? '-' : '+') + String(Math.abs(v)).padStart(2, '0'), 12),
    };
    this.loopButtons = [
      toggle('Off', () => this.setLoop(LoopType.None), 'No loop'),
      toggle('Fwd', () => this.setLoop(LoopType.Forward), 'Forward loop'),
      toggle('Ping', () => this.setLoop(LoopType.PingPong), 'Ping-pong loop'),
    ];
    this.waveLength = stepper('Len', (d) => this.stepWaveLength(d), (i) => String(WAVE_LENGTHS[i] ?? 32), 1);

    const props = el('div', 'tool-row');
    props.append(this.name.root, ...Object.values(this.fields).map((f) => f.root), el('span', 'label', 'Loop'), ...this.loopButtons);

    const tools = el('div', 'tool-row');
    tools.append(
      button('Load', () => host.importFile(), 'Load WAV, AIFF, FLAC, MP3, OGG, 8SVX or XI into this slot'),
      button('Cut', () => this.cut(), 'Cut the selection'),
      button('Copy', () => this.copy(), 'Copy the selection'),
      button('Paste', () => this.paste(), 'Paste at the cursor, or over the selection'),
      button('Crop', () => this.rangeTool('crop', cropRange), 'Keep only the selection'),
      button('Clear', () => this.rangeTool('silence', silenceRange), 'Silence the selection'),
      button('Rev', () => this.rangeTool('reverse', reverseRange), 'Reverse'),
      button('Norm', () => this.rangeTool('normalize', normalizeRange), 'Normalize to full scale'),
      button('Vol-', () => this.rangeTool('amplify', (s, r) => amplifyRange(s, r, 0.5)), 'Halve the volume'),
      button('Vol+', () => this.rangeTool('amplify', (s, r) => amplifyRange(s, r, 2)), 'Double the volume (clips)'),
      button('FadeIn', () => this.rangeTool('fade in', fadeIn)),
      button('FadeOut', () => this.rangeTool('fade out', fadeOut)),
      button('x2', () => this.edit('resample', (s) => resample(s, 2)), 'Resample to twice the length, same pitch'),
      button('/2', () => this.edit('resample', (s) => resample(s, 0.5)), 'Resample to half the length, same pitch'),
      button('Sel>Loop', () => this.loopFromSelection(), 'Loop the selection'),
      button('Zoom', () => this.zoomToSelection(), 'Zoom to the selection'),
      button('All', () => this.showAll(), 'Show the whole sample'),
    );

    const extra = el('div', 'tool-row');
    extra.append(
      el('span', 'label', 'Tools'),
      button('Inv', () => this.rangeTool('invert', invertRange), 'Turn the waveform upside down'),
      button('Sign', () => this.rangeTool('sign', toggleSignRange), 'Toggle signed/unsigned, for samples imported the wrong way'),
      button('Swap', () => this.rangeTool('byte swap', swapBytesRange), 'Swap the bytes of 16-bit frames, for samples with the wrong byte order'),
      button('DC', () => this.rangeTool('DC offset', removeDcRange), 'Remove the DC offset'),
      button('8-Bit', () => this.edit('8-bit', quantize8), 'Reduce to 8 bits; the sample is then saved as 8-bit'),
      button('LP', () => this.filter('lowpass'), 'Low-pass filter the selection'),
      button('HP', () => this.filter('highpass'), 'High-pass filter the selection'),
      button('XFade', () => this.crossfade(), 'Crossfade the loop end into the frames before the loop start'),
      button('Rsmp', () => this.resampleTo(), 'Resample to any length, same pitch'),
      button('Save', () => host.saveSample(), 'Save the sample as WAV'),
    );

    const generate = el('div', 'tool-row');
    generate.append(
      el('span', 'label', 'Generate'),
      ...WAVE_SHAPES.map((shape) => button(WAVE_LABELS[shape], () => this.generate(shape), `Replace the sample with a looped ${shape} wave`)),
      this.waveLength.root,
      this.info,
    );

    this.root.append(props, tools, extra, generate, this.layers.root);
    this.waveLength.show(this.waveLengthIndex);
    this.bindCanvas();
    new ResizeObserver(() => {
      this.draw();
      this.drawVoices();
    }).observe(this.canvas);
  }

  /** Shows where the voices playing this sample are, as moving play markers. */
  showVoices(voices: VoiceState[]): void {
    this.voices = voices;
    this.drawVoices();
  }

  private drawVoices(): void {
    const s = this.sample();
    const ins = this.host.instrumentIndex() + 1;
    const slot = this.host.sampleIndex();
    const v = s && s.data.length ? this.visible(s) : null;
    const positions = v
      ? this.voices.filter((voice) => voice.instrument === ins && voice.sample === slot).map((voice) => (voice.pos - v.start) / (v.end - v.start))
      : [];
    drawMarkers(this.layers.overlay, positions);
  }

  private sample(): Sample | null {
    return this.host.editor.song.instruments[this.host.instrumentIndex()]?.samples[this.host.sampleIndex()] ?? null;
  }

  /** Edits the current sample, creating the slot when it does not exist yet. */
  private edit(label: string, fn: (sample: Sample) => void): void {
    const sIndex = this.host.sampleIndex();
    this.host.editor.editInstrument(this.host.instrumentIndex(), label, (ins) => {
      while (ins.samples.length <= sIndex) ins.samples.push(emptySample());
      const sample = ins.samples[sIndex]!;
      fn(sample);
      fixLoop(sample);
    });
  }

  private nudge(field: 'volume' | 'panning' | 'finetune' | 'relativeNote', delta: number, min: number, max: number): void {
    this.edit(field, (s) => (s[field] = Math.max(min, Math.min(max, s[field] + delta))));
  }

  private setLoop(type: LoopType): void {
    this.edit('loop', (s) => {
      s.loopType = type;
      if (type !== LoopType.None && s.loopLength < 1) {
        s.loopStart = 0;
        s.loopLength = s.data.length;
      }
    });
  }

  private range(): Range | null {
    const s = this.sample();
    if (!s || s.data.length === 0) return null;
    const sel = this.selection;
    return sel && sel.end > sel.start ? sel : { start: 0, end: s.data.length };
  }

  /** The rate the sample plays at on C-4, which filter cutoffs refer to. */
  private sampleRate(): number {
    const s = this.sample();
    return s ? rateForTuning(s.relativeNote, s.finetune) : 8363;
  }

  private filter(kind: 'lowpass' | 'highpass'): void {
    const rate = Math.round(this.sampleRate());
    const answer = prompt(`${kind === 'lowpass' ? 'Low' : 'High'}-pass cutoff in Hz (sample plays at ${rate} Hz on C-4):`, kind === 'lowpass' ? '2000' : '100');
    const cutoff = Number(answer);
    if (!answer || !(cutoff > 0)) return;
    this.rangeTool(kind, (s, r) => filterRange(s, r, kind, cutoff, rate));
  }

  private crossfade(): void {
    const s = this.sample();
    if (!s || s.loopType === LoopType.None) {
      this.host.status('Crossfade needs a loop.');
      return;
    }
    const answer = prompt('Crossfade length in frames:', String(Math.min(256, Math.floor(s.loopLength / 4)) || 1));
    const frames = Math.floor(Number(answer));
    if (!answer || !(frames > 0)) return;
    let done = 0;
    this.edit('crossfade loop', (sample) => (done = crossfadeLoop(sample, frames)));
    this.host.status(done ? `Crossfaded ${done} frames into the loop start.` : 'No room before the loop start to crossfade.');
  }

  private resampleTo(): void {
    const s = this.sample();
    if (!s || s.data.length === 0) return;
    const answer = prompt(`New length in frames (now ${s.data.length}); the pitch stays:`, String(s.data.length));
    const frames = Math.floor(Number(answer));
    if (!answer || !(frames > 0) || frames === s.data.length) return;
    this.edit('resample', (sample) => resample(sample, frames / sample.data.length));
  }

  private rangeTool(label: string, op: (s: Sample, r: Range) => void): void {
    const r = this.range();
    if (!r) return;
    this.edit(label, (s) => op(s, r));
    if (label === 'crop') this.selection = null;
  }

  private copy(): void {
    const s = this.sample();
    const r = this.range();
    if (!s || !r) return;
    this.clipboard = copyRange(s, r);
    this.host.status(`Copied ${this.clipboard.length} frames.`);
  }

  private cut(): void {
    const sel = this.selection;
    if (!sel || sel.end <= sel.start) return;
    this.copy();
    this.edit('cut', (s) => deleteRange(s, sel));
    this.selection = { start: sel.start, end: sel.start };
  }

  private paste(): void {
    const clip = this.clipboard;
    if (!clip) return;
    const sel = this.selection ?? { start: this.sample()?.data.length ?? 0, end: this.sample()?.data.length ?? 0 };
    this.edit('paste', (s) => {
      if (sel.end > sel.start) deleteRange(s, sel);
      insertFrames(s, sel.start, clip);
    });
    this.selection = { start: sel.start, end: sel.start + clip.length };
  }

  private loopFromSelection(): void {
    const sel = this.selection;
    if (!sel || sel.end <= sel.start) return;
    this.edit('loop', (s) => {
      s.loopStart = sel.start;
      s.loopLength = sel.end - sel.start;
      if (s.loopType === LoopType.None) s.loopType = LoopType.Forward;
    });
  }

  private stepWaveLength(delta: number): void {
    this.waveLengthIndex = Math.max(0, Math.min(WAVE_LENGTHS.length - 1, this.waveLengthIndex + delta));
    this.waveLength.show(this.waveLengthIndex);
  }

  private generate(shape: WaveShape): void {
    const length = WAVE_LENGTHS[this.waveLengthIndex] ?? 32;
    this.edit('generate', (s) => {
      s.data = generateWave(shape, length, Date.now() & 0xffff);
      s.loopType = LoopType.Forward;
      s.loopStart = 0;
      s.loopLength = length;
      // A 32-frame cycle sounds at C-4; longer cycles are tuned up to match.
      Object.assign(s, tuningForRate((8363 * length) / 32));
      if (!s.name) s.name = shape;
    });
    this.selection = null;
    this.zoom = null;
  }

  private zoomToSelection(): void {
    const sel = this.selection;
    if (sel && sel.end - sel.start >= 2) this.zoom = { ...sel };
    this.draw();
  }

  private showAll(): void {
    this.zoom = null;
    this.draw();
  }

  /** Forgets selection and zoom, for a sample that was just replaced. */
  resetView(): void {
    this.selection = null;
    this.zoom = null;
    this.render();
  }

  // ---- Drawing and mouse --------------------------------------------------

  private visible(s: Sample): Range {
    const len = s.data.length;
    const z = this.zoom;
    return z && z.end <= len ? z : { start: 0, end: Math.max(1, len) };
  }

  private frameAt(clientX: number): number {
    const s = this.sample();
    if (!s) return 0;
    const box = this.canvas.getBoundingClientRect();
    const v = this.visible(s);
    const t = Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width)));
    return Math.round(v.start + t * (v.end - v.start));
  }

  private xOf(frame: number, s: Sample): number {
    const v = this.visible(s);
    return ((frame - v.start) / (v.end - v.start)) * this.canvas.getBoundingClientRect().width;
  }

  private bindCanvas(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (event) => {
      const s = this.sample();
      if (!s || s.data.length === 0) return;
      c.setPointerCapture(event.pointerId);
      const x = event.clientX - c.getBoundingClientRect().left;
      const looped = s.loopType !== LoopType.None && s.loopLength > 0;
      const near = (frame: number) => Math.abs(this.xOf(frame, s) - x) <= 6;
      const index = this.host.instrumentIndex();
      if (looped && near(s.loopStart)) {
        this.drag = { kind: 'loopStart', anchor: 0, before: this.host.editor.snapshotInstrument(index) };
      } else if (looped && near(s.loopStart + s.loopLength)) {
        this.drag = { kind: 'loopEnd', anchor: 0, before: this.host.editor.snapshotInstrument(index) };
      } else {
        const f = this.frameAt(event.clientX);
        this.drag = { kind: 'select', anchor: f, before: null };
        this.selection = { start: f, end: f };
        this.draw();
      }
    });
    c.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      const s = this.sample();
      if (!drag || !s) return;
      const f = this.frameAt(event.clientX);
      if (drag.kind === 'select') {
        this.selection = { start: Math.min(drag.anchor, f), end: Math.max(drag.anchor, f) };
      } else {
        const end = s.loopStart + s.loopLength;
        if (drag.kind === 'loopStart') {
          s.loopStart = Math.min(f, end - 1);
          s.loopLength = end - s.loopStart;
        } else {
          s.loopLength = Math.max(1, f - s.loopStart);
        }
        fixLoop(s);
        this.host.editor.previewInstrument(this.host.instrumentIndex());
      }
      this.draw();
    });
    const finish = () => {
      const drag = this.drag;
      this.drag = null;
      if (drag?.before) this.host.editor.recordInstrument(this.host.instrumentIndex(), 'loop', drag.before);
      this.render();
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
    c.addEventListener('dblclick', () => {
      const s = this.sample();
      if (s) this.selection = { start: 0, end: s.data.length };
      this.draw();
    });
  }

  /** Updates the fields and redraws, after any change to the song. */
  render(): void {
    const s = this.sample();
    this.name.input.value = s?.name ?? '';
    this.fields.volume.show(s?.volume ?? 0);
    this.fields.panning.show(s?.panning ?? 128);
    this.fields.finetune.show(s?.finetune ?? 0);
    this.fields.relativeNote.show(s?.relativeNote ?? 0);
    this.loopButtons.forEach((b, i) => setPressed(b, (s?.loopType ?? LoopType.None) === i));
    const len = s?.data.length ?? 0;
    if (this.selection && this.selection.end > len) this.selection = null;
    if (this.zoom && this.zoom.end > len) this.zoom = null;
    this.draw();
  }

  private draw(): void {
    this.drawVoices();
    const s = this.sample();
    const g = fitCanvas(this.canvas);
    if (!g) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.fillStyle = cssColor('--pat-bg', '#000');
    g.fillRect(0, 0, w, h);
    g.fillStyle = cssColor('--pat-sep', '#22304a');
    g.fillRect(0, h >> 1, w, 1);

    const len = s?.data.length ?? 0;
    const sel = this.selection;
    this.info.textContent = !s || len === 0 ? 'Empty slot' : sel && sel.end > sel.start ? `Sel ${sel.start}-${sel.end} (${sel.end - sel.start})  Len ${len}` : `Len ${len}`;
    if (!s || len === 0) return;

    const v = this.visible(s);
    const span = v.end - v.start;
    const x = (frame: number) => ((frame - v.start) / span) * w;

    if (s.loopType !== LoopType.None && s.loopLength > 0) {
      g.fillStyle = 'rgb(255 216 74 / 12%)';
      g.fillRect(x(s.loopStart), 0, x(s.loopStart + s.loopLength) - x(s.loopStart), h);
    }
    if (sel && sel.end > sel.start) {
      g.fillStyle = cssColor('--pat-sel', '#3c3f8f');
      g.fillRect(x(sel.start), 0, Math.max(1, x(sel.end) - x(sel.start)), h);
    }

    // One min/max line per pixel column. Each column also reaches to where the
    // next one starts, so zoomed-in or high-density screens draw a joined line.
    g.fillStyle = cssColor('--pat-vol', '#7fff8f');
    const mid = h / 2;
    const thickness = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const at = (f: number) => {
      const i = Math.min(len - 1, Math.max(0, Math.floor(f)));
      const next = s.data[Math.min(len - 1, i + 1)]!;
      return s.data[i]! + (next - s.data[i]!) * Math.min(1, Math.max(0, f - i));
    };
    for (let px = 0; px < w; px++) {
      const f0 = v.start + (px / w) * span;
      const f1 = v.start + ((px + 1) / w) * span;
      if (f0 >= len) break;
      const e0 = at(f0);
      const e1 = at(Math.min(f1, len - 1));
      let lo = Math.min(e0, e1);
      let hi = Math.max(e0, e1);
      for (let i = Math.ceil(f0); i < f1 && i < len; i++) {
        const value = s.data[i]!;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      const y0 = mid - hi * (mid - 1);
      const y1 = mid - lo * (mid - 1);
      g.fillRect(px, y0 - thickness / 2, 1, Math.max(thickness, y1 - y0 + thickness));
    }

    if (sel) {
      g.fillStyle = '#ffffff';
      g.fillRect(x(sel.start), 0, 1, h);
    }
    if (s.loopType !== LoopType.None && s.loopLength > 0) {
      g.fillStyle = cssColor('--pat-cell', '#ffd84a');
      const marker = Math.max(2, Math.round(window.devicePixelRatio || 1) * 2);
      g.fillRect(x(s.loopStart), 0, marker, h);
      g.fillRect(x(s.loopStart + s.loopLength) - marker, 0, marker, h);
    }
  }
}
