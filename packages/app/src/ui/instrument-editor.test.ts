// @vitest-environment happy-dom
import { createSong, type Envelope } from '@webtracker/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SongEditor } from '../editor/song-editor.ts';
import { contextOf, installDom, pointer, resizeAll, setBox } from '../test-dom.ts';
import { InstrumentEditor, type InstrumentEditorHost } from './instrument-editor.ts';

/**
 * The instrument editor with a real SongEditor behind it. Each envelope
 * canvas is 640 x 128 px and shows 64 ticks, so a tick is 10 px and the
 * top edge is volume 64.
 */

let editor: SongEditor;
let host: InstrumentEditorHost & { statuses: string[]; sample: number };
let view: InstrumentEditor;

beforeEach(() => {
  installDom();
  editor = new SongEditor(createSong(4), () => {});
  host = {
    editor,
    statuses: [],
    sample: 0,
    instrumentIndex: () => 0,
    sampleIndex: () => host.sample,
    status: (text) => host.statuses.push(text),
    importFile: vi.fn(),
    openLibrary: vi.fn(),
    saveInstrument: vi.fn(),
  };
  view = new InstrumentEditor(host);
  document.body.replaceChildren(view.root);
  for (const c of view.root.querySelectorAll('canvas')) setBox(c, { left: 0, top: 0, width: 640, height: 128 });
  view.render();
});

const ins = () => editor.song.instruments[0]!;
const envView = (n: 0 | 1) => view.root.querySelectorAll<HTMLElement>('.envelope')[n]!;
const canvas = (n: 0 | 1 = 0) => envView(n).querySelector<HTMLCanvasElement>('canvas:not(.overlay)')!;
const overlay = (n: 0 | 1 = 0) => envView(n).querySelector<HTMLCanvasElement>('canvas.overlay')!;
const btn = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label)!;
const info = (n: 0 | 1 = 0) => envView(n).querySelector('.info')!.textContent;
/** Screen position of an envelope point. */
const at = (x: number, y: number): [number, number] => [x * 10, (1 - y / 64) * 128];
const click = (x: number, y: number, n: 0 | 1 = 0) => {
  canvas(n).dispatchEvent(pointer('pointerdown', ...at(x, y)));
  canvas(n).dispatchEvent(pointer('pointerup', ...at(x, y)));
};
const points = (e: Envelope) => e.points.map((p) => [p.x, p.y]);

describe('instrument editor', () => {
  it('renames the instrument as one undo step', () => {
    const name = view.root.querySelector<HTMLInputElement>('.text-field input')!;
    name.value = 'Lead';
    name.dispatchEvent(new Event('change'));
    expect(ins().name).toBe('Lead');
    expect(editor.undo()).toBe('name');
  });

  it('adds points by clicking, the first at tick 0, and switches the envelope on', () => {
    expect(info()).toBe('Click to add points');
    btn(envView(0), 'On').click();
    expect(ins().volumeEnvelope.enabled).toBe(false);
    click(5, 64);
    expect(points(ins().volumeEnvelope)).toEqual([[0, 64]]);
    expect(ins().volumeEnvelope.enabled).toBe(true);
    click(20, 32);
    click(10, 48);
    expect(points(ins().volumeEnvelope)).toEqual([[0, 64], [10, 48], [20, 32]]);
    expect(info()).toBe('Pt 2/3  X 10  Y 30');
    // Nothing goes before the first point or onto a tick that has one.
    view.render();
    expect(btn(envView(0), 'On').getAttribute('aria-pressed')).toBe('true');
  });

  it('drags a point between its neighbours as one undo step, and keeps the first at tick 0', () => {
    for (const [x, y] of [[0, 64], [10, 48], [20, 32]] as const) click(x, y);
    const undoBefore = editor.history;
    canvas().dispatchEvent(pointer('pointerdown', ...at(10, 48)));
    canvas().dispatchEvent(pointer('pointermove', ...at(15, 40)));
    canvas().dispatchEvent(pointer('pointermove', ...at(40, 70)));
    canvas().dispatchEvent(pointer('pointerup', ...at(40, 70)));
    expect(points(ins().volumeEnvelope)).toEqual([[0, 64], [19, 64], [20, 32]]);
    expect(editor.undo()).toBe('envelope');
    expect(points(ins().volumeEnvelope)).toEqual([[0, 64], [10, 48], [20, 32]]);
    expect(editor.history).toBe(undoBefore);
    canvas().dispatchEvent(pointer('pointerdown', ...at(0, 64)));
    canvas().dispatchEvent(pointer('pointermove', ...at(8, 10)));
    canvas().dispatchEvent(pointer('pointercancel', ...at(8, 10)));
    expect(points(ins().volumeEnvelope)[0]).toEqual([0, 10]);
    // A right button press adds nothing.
    canvas().dispatchEvent(pointer('pointerdown', ...at(30, 30), { button: 2 }));
    expect(ins().volumeEnvelope.points).toHaveLength(3);
  });

  it('stops at twelve points', () => {
    for (let i = 0; i < 14; i++) click(i * 4, 32);
    expect(ins().volumeEnvelope.points).toHaveLength(12);
  });

  it('deletes points with a right click or DelPt, keeping the first while others are left', () => {
    for (const [x, y] of [[0, 64], [10, 48], [20, 32]] as const) click(x, y);
    const menu = new MouseEvent('contextmenu', { clientX: at(10, 48)[0], clientY: at(10, 48)[1], cancelable: true });
    canvas().dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(points(ins().volumeEnvelope)).toEqual([[0, 64], [20, 32]]);
    // A right click beside the points deletes nothing.
    canvas().dispatchEvent(new MouseEvent('contextmenu', { clientX: 300, clientY: 5 }));
    expect(ins().volumeEnvelope.points).toHaveLength(2);
    click(0, 64);
    btn(envView(0), 'DelPt').click();
    expect(ins().volumeEnvelope.points).toHaveLength(2);
    click(20, 32);
    btn(envView(0), 'DelPt').click();
    btn(envView(0), 'DelPt').click();
    expect(ins().volumeEnvelope.points).toHaveLength(0);
    expect(ins().volumeEnvelope.enabled).toBe(false);
  });

  it('sets sustain and loop points from the selected point', () => {
    for (const [x, y] of [[0, 64], [10, 48], [20, 32], [30, 0]] as const) click(x, y);
    click(10, 48);
    btn(envView(0), 'Sus').click();
    btn(envView(0), 'Sus=Pt').click();
    click(20, 32);
    btn(envView(0), 'Loop').click();
    btn(envView(0), 'LpE=Pt').click();
    click(10, 48);
    btn(envView(0), 'LpS=Pt').click();
    expect(ins().volumeEnvelope).toMatchObject({ sustain: true, sustainPoint: 1, loop: true, loopStart: 1, loopEnd: 2 });
    // Deleting a point before them moves them along.
    click(10, 48);
    btn(envView(0), 'DelPt').click();
    expect(ins().volumeEnvelope).toMatchObject({ sustainPoint: 1, loopStart: 1, loopEnd: 1 });
    // A new point before them moves them the other way.
    click(5, 50);
    expect(ins().volumeEnvelope).toMatchObject({ sustainPoint: 2, loopStart: 2, loopEnd: 2 });
    const marks = contextOf(canvas()).calls.filter((c) => c.op === 'fillRect' && (c.args[2] as number) === 1);
    expect(marks.length).toBeGreaterThan(0);
  });

  it('applies presets and copies envelopes between volume and panning', () => {
    btn(envView(0), 'Paste').click();
    expect(host.statuses.at(-1)).toBe('Copy an envelope first.');
    const preset = envView(0).querySelector<HTMLSelectElement>('select')!;
    preset.value = '1';
    preset.dispatchEvent(new Event('change'));
    expect(points(ins().volumeEnvelope)).toEqual([[0, 64], [128, 0]]);
    expect(preset.value).toBe('');
    expect(host.statuses.at(-1)).toBe('Decay envelope.');
    // The placeholder applies nothing.
    preset.value = '';
    preset.dispatchEvent(new Event('change'));
    expect(points(ins().volumeEnvelope)).toEqual([[0, 64], [128, 0]]);
    btn(envView(0), 'Copy').click();
    expect(host.statuses.at(-1)).toBe('Copied the envelope, 2 points.');
    btn(envView(1), 'Paste').click();
    expect(points(ins().panningEnvelope)).toEqual([[0, 64], [128, 0]]);
    expect(editor.undo()).toBe('paste envelope');
  });

  it('marks the envelope positions and keys of the voices playing it', () => {
    click(0, 64);
    click(32, 0);
    const voice = { channel: 0, instrument: 1, sample: 0, note: 49, pos: 0, volEnvTick: 32, panEnvTick: 0 };
    view.showVoices([voice, { ...voice, instrument: 2, note: 13 }]);
    const markers = contextOf(overlay()).calls.filter((c) => c.op === 'fillRect');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.args[0]).toBe(320);
    const keys = view.root.querySelectorAll('.keymap button');
    expect([...keys].filter((k) => k.classList.contains('playing')).map((k) => k.getAttribute('title'))).toEqual(['C-4']);
    // The panning envelope is off, so it shows no marker.
    expect(contextOf(overlay(1)).calls.filter((c) => c.op === 'fillRect')).toHaveLength(0);
    // A resize redraws both layers.
    contextOf(overlay()).clear();
    resizeAll();
    expect(contextOf(overlay()).calls.filter((c) => c.op === 'fillRect')).toHaveLength(1);
  });

  it('steps fadeout and auto-vibrato within their ranges', () => {
    const stepperOf = (label: string) => [...view.root.querySelectorAll('.stepper')].find((s) => s.querySelector('.label')!.textContent === label)!;
    const plus = (label: string, shift = false) => btn(stepperOf(label), '+').dispatchEvent(new MouseEvent('click', { shiftKey: shift }));
    plus('Fadeout', true);
    expect(ins().fadeout).toBe(256);
    for (let i = 0; i < 20; i++) plus('Fadeout', true);
    expect(ins().fadeout).toBe(0xfff);
    plus('Depth', true);
    expect(ins().vibratoDepth).toBe(15);
    btn(stepperOf('Rate'), '-').click();
    expect(ins().vibratoRate).toBe(0);
    view.render();
    expect(stepperOf('Fadeout').querySelector('output')!.textContent).toBe('FFF');
    const type = btn(view.root, 'Sine');
    type.click();
    view.render();
    expect(type.textContent).toBe('Square');
    for (let i = 0; i < 3; i++) type.click();
    expect(ins().vibratoType).toBe(0);
  });

  it('maps keys to the selected sample, one key or all', () => {
    host.sample = 2;
    const keys = [...view.root.querySelectorAll<HTMLButtonElement>('.keymap button')];
    keys[49]!.click();
    expect(ins().keymap[49]).toBe(2);
    expect(ins().keymap[48]).toBe(0);
    view.render();
    expect(keys[49]!.textContent).toBe('2');
    // The instrument has one sample, so sample 2 is missing.
    expect(keys[49]!.classList.contains('missing')).toBe(true);
    expect(keys[49]!.classList.contains('current')).toBe(true);
    btn(view.root, 'All').click();
    expect([...ins().keymap].every((s) => s === 2)).toBe(true);
  });

  it('hands loading, the library and saving to the host', () => {
    btn(view.root, 'Load').click();
    btn(view.root, 'Library').click();
    btn(view.root, 'Save XI').click();
    expect(host.importFile).toHaveBeenCalledOnce();
    expect(host.openLibrary).toHaveBeenCalledOnce();
    expect(host.saveInstrument).toHaveBeenCalledOnce();
  });
});
