// @vitest-environment happy-dom
import { createSong, emptySample, LoopType, type Sample } from '@webtracker/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SongEditor } from '../editor/song-editor.ts';
import { contextOf, installDom, pointer, setBox } from '../test-dom.ts';
import { SampleEditor, type SampleEditorHost } from './sample-editor.ts';

/**
 * The sample editor with a real SongEditor behind it. The sample has 100
 * frames and the waveform canvas is 100 x 100 px, so a pixel is a frame
 * and the top edge is level 1.
 */

let editor: SongEditor;
let host: SampleEditorHost & { statuses: string[]; slot: number };
let view: SampleEditor;

/** A sample that every tool changes: a sine with a DC offset, off the 8-bit grid. */
function testSample(): Sample {
  const sample = emptySample();
  sample.name = 'wave';
  sample.volume = 0x40;
  sample.panning = 0x80;
  sample.data = Float32Array.from({ length: 100 }, (_, i) => 0.1 + 0.3 * Math.sin(i / 5) + 0.001);
  return sample;
}

beforeEach(() => {
  installDom();
  const song = createSong(4);
  song.instruments[0]!.samples = [testSample()];
  editor = new SongEditor(song, () => {});
  host = {
    editor,
    statuses: [],
    slot: 0,
    instrumentIndex: () => 0,
    sampleIndex: () => host.slot,
    status: (text) => host.statuses.push(text),
    importFile: vi.fn(),
    openLibrary: vi.fn(),
    saveSample: vi.fn(),
  };
  view = new SampleEditor(host);
  // The page redraws the editors after every change, as here.
  editor.onChange = () => view.render();
  document.body.replaceChildren(view.root);
  for (const c of view.root.querySelectorAll('canvas')) setBox(c, { left: 0, top: 0, width: 100, height: 100 });
  view.render();
});

const sample = () => editor.song.instruments[0]!.samples[host.slot]!;
const canvas = () => view.root.querySelector<HTMLCanvasElement>('canvas:not(.overlay)')!;
const overlay = () => view.root.querySelector<HTMLCanvasElement>('canvas.overlay')!;
const btn = (label: string) => [...view.root.querySelectorAll('button')].find((b) => b.textContent === label)!;
const press = (label: string) => btn(label).click();
const info = () => view.root.querySelector('.info')!.textContent;
const field = (label: string) => [...view.root.querySelectorAll('.stepper')].find((s) => s.querySelector('.label')!.textContent === label)!;
const fieldValue = (label: string) => field(label).querySelector('output')!.textContent;
const step = (label: string, sign: '-' | '+', shiftKey = false) =>
  [...field(label).querySelectorAll('button')].find((b) => b.textContent === sign)!.dispatchEvent(new MouseEvent('click', { shiftKey, bubbles: true }));
const drag = (from: [number, number], ...to: [number, number][]) => {
  canvas().dispatchEvent(pointer('pointerdown', ...from));
  for (const p of to) canvas().dispatchEvent(pointer('pointermove', ...p));
  canvas().dispatchEvent(pointer('pointerup', ...(to.at(-1) ?? from)));
};
const select = (start: number, end: number) => drag([start, 50], [end, 50]);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Answers the dialog that a tool opened, or cancels it with null. */
async function answer(text: string | null): Promise<void> {
  const dialog = await vi.waitFor(() => document.querySelector('dialog')!);
  if (text === null) {
    [...dialog.querySelectorAll('button')].find((b) => b.value !== 'ok')!.click();
  } else {
    dialog.querySelector('input')!.value = text;
    dialog.querySelector<HTMLButtonElement>('button[value="ok"]')!.click();
  }
  await flush();
}

describe('sample editor', () => {
  it('shows the sample, and an empty slot until something goes in it', () => {
    expect(view.root.querySelector('input')!.value).toBe('wave');
    expect([fieldValue('Vol'), fieldValue('Pan'), fieldValue('Fine'), fieldValue('Rel')]).toEqual(['40', '80', '+00', '+00']);
    expect(info()).toBe('Len 100');
    expect(btn('Off').getAttribute('aria-pressed')).toBe('true');
    host.slot = 2;
    view.render();
    expect(info()).toBe('Empty slot');
    expect(fieldValue('Pan')).toBe('80');
    // Editing an empty slot makes it, and the ones before it.
    step('Vol', '-');
    expect(editor.song.instruments[0]!.samples).toHaveLength(3);
    expect(sample().volume).toBe(63);
  });

  it('edits the name and nudges the fields within their ranges', () => {
    const name = view.root.querySelector('input')!;
    name.value = 'bass';
    name.dispatchEvent(new Event('change'));
    expect(sample().name).toBe('bass');
    step('Vol', '+', true);
    expect(sample().volume).toBe(64);
    step('Fine', '-', true);
    step('Fine', '-');
    expect(sample().finetune).toBe(-17);
    step('Rel', '+', true);
    expect(sample().relativeNote).toBe(12);
    step('Pan', '-');
    expect(editor.undo()).toBe('panning');
    view.render();
    expect([fieldValue('Fine'), fieldValue('Rel')]).toEqual(['-11', '+12']);
  });

  it('selects by dragging and everything by double-click', () => {
    select(30, 10);
    expect(info()).toBe('Sel 10-30 (20)  Len 100');
    canvas().dispatchEvent(new MouseEvent('dblclick'));
    expect(info()).toBe('Sel 0-100 (100)  Len 100');
    // A click alone sets a cursor.
    select(40, 40);
    expect(info()).toBe('Len 100');
  });

  it('cuts, copies and pastes frames', () => {
    const original = Array.from(sample().data);
    press('Paste');
    expect(sample().data).toHaveLength(100);
    select(10, 30);
    press('Cut');
    expect(host.statuses.at(-1)).toBe('Copied 20 frames.');
    expect(sample().data).toHaveLength(80);
    expect(info()).toBe('Len 80');
    // The cursor stays where the cut was, so paste puts it back.
    press('Paste');
    expect(Array.from(sample().data)).toEqual(original);
    expect(info()).toBe('Sel 10-30 (20)  Len 100');
    // Pasting over a selection replaces it.
    select(0, 50);
    press('Paste');
    expect(sample().data).toHaveLength(70);
    // Without a selection copy takes the whole sample; cut needs one.
    view.resetView();
    press('Copy');
    expect(host.statuses.at(-1)).toBe('Copied 70 frames.');
    press('Cut');
    expect(sample().data).toHaveLength(70);
    // Paste with no cursor goes at the end.
    press('Paste');
    expect(sample().data).toHaveLength(140);
  });

  it.each([
    ['Clear', 'silence'],
    ['Rev', 'reverse'],
    ['Norm', 'normalize'],
    ['Vol-', 'amplify'],
    ['Vol+', 'amplify'],
    ['FadeIn', 'fade in'],
    ['FadeOut', 'fade out'],
    ['Inv', 'invert'],
    ['Sign', 'sign'],
    ['Swap', 'byte swap'],
    ['DC', 'DC offset'],
    ['8-Bit', '8-bit'],
  ])('%s changes the frames as one undo step', (label, undo) => {
    const before = Array.from(sample().data);
    press(label);
    expect(Array.from(sample().data)).not.toEqual(before);
    expect(editor.undo()).toBe(undo);
    expect(Array.from(sample().data)).toEqual(before);
  });

  it('works on the selection only, and crop keeps just that', () => {
    const before = Array.from(sample().data);
    select(10, 20);
    press('Clear');
    expect(Array.from(sample().data.slice(10, 20))).toEqual(Array(10).fill(0));
    expect(Array.from(sample().data.slice(0, 10))).toEqual(before.slice(0, 10));
    select(1, 10);
    press('Crop');
    expect(info()).toBe('Len 9');
    editor.undo();
    select(40, 60);
    press('Crop');
    expect(sample().data).toHaveLength(20);
    expect(info()).toBe('Len 20');
  });

  it('resamples to twice and half the length', () => {
    press('x2');
    expect(sample().data).toHaveLength(200);
    press('/2');
    press('/2');
    expect(sample().data).toHaveLength(50);
  });

  it('sets loops with the buttons and from the selection', () => {
    press('Fwd');
    expect(sample()).toMatchObject({ loopType: LoopType.Forward, loopStart: 0, loopLength: 100 });
    expect(btn('Fwd').getAttribute('aria-pressed')).toBe('true');
    select(20, 60);
    press('Sel>Loop');
    expect(sample()).toMatchObject({ loopType: LoopType.Forward, loopStart: 20, loopLength: 40 });
    press('Ping');
    expect(sample()).toMatchObject({ loopType: LoopType.PingPong, loopStart: 20, loopLength: 40 });
    press('Off');
    select(10, 30);
    press('Sel>Loop');
    expect(sample()).toMatchObject({ loopType: LoopType.Forward, loopStart: 10, loopLength: 20 });
    // Without a selection it does nothing.
    select(50, 50);
    press('Sel>Loop');
    expect(sample().loopStart).toBe(10);
  });

  it('drags the loop markers, as one undo step each', () => {
    Object.assign(sample(), { loopType: LoopType.Forward, loopStart: 20, loopLength: 40 });
    view.render();
    const marks = contextOf(canvas()).calls.filter((c) => c.op === 'fillRect' && c.args[3] === 100 && c.args[2] === 2);
    expect(marks.map((c) => c.args[0])).toEqual([20, 58]);
    drag([22, 50], [30, 50]);
    expect(sample()).toMatchObject({ loopStart: 30, loopLength: 30 });
    expect(editor.undo()).toBe('loop');
    expect(sample()).toMatchObject({ loopStart: 20, loopLength: 40 });
    drag([58, 50], [80, 50]);
    expect(sample()).toMatchObject({ loopStart: 20, loopLength: 60 });
    // The start never passes the end.
    drag([20, 50], [99, 50]);
    expect(sample()).toMatchObject({ loopStart: 79, loopLength: 1 });
  });

  it('draws the waveform by hand in Quick Draw', () => {
    press('Draw');
    expect(host.statuses.at(-1)).toBe('Quick Draw on: drag on the waveform to draw.');
    expect(canvas().classList.contains('drawing')).toBe(true);
    // From the top edge at frame 10 to the bottom at frame 20, then on past the end.
    drag([10, 0], [20, 100], [150, 100]);
    expect(sample().data[10]).toBeCloseTo(1, 5);
    expect(sample().data[15]).toBeCloseTo(0, 5);
    expect(sample().data[20]).toBeCloseTo(-1, 5);
    expect(sample().data[99]).toBeCloseTo(-1, 5);
    expect(editor.undo()).toBe('draw');
    expect(sample().data[10]).not.toBeCloseTo(1, 2);
    press('Draw');
    expect(host.statuses.at(-1)).toBe('Quick Draw off.');
    select(10, 20);
    expect(info()).toBe('Sel 10-20 (10)  Len 100');
  });

  it('generates looped waves of the chosen length', () => {
    expect(fieldValue('Len')).toBe('32');
    step('Len', '+');
    expect(fieldValue('Len')).toBe('64');
    select(10, 20);
    press('Sqr');
    expect(info()).toBe('Len 64');
    expect(sample()).toMatchObject({ loopType: LoopType.Forward, loopStart: 0, loopLength: 64, name: 'wave' });
    expect(sample().data).toHaveLength(64);
    // Twice the 32-frame cycle is tuned an octave up.
    expect(sample().relativeNote).toBe(12);
    for (let i = 0; i < 9; i++) step('Len', '+');
    expect(fieldValue('Len')).toBe('1024');
    for (let i = 0; i < 9; i++) step('Len', '-');
    expect(fieldValue('Len')).toBe('16');
    host.slot = 1;
    press('Nse');
    expect(sample()).toMatchObject({ name: 'noise', loopLength: 16 });
  });

  it('zooms to the selection and back', () => {
    select(20, 40);
    press('Zoom');
    // The canvas now shows frames 20 to 40, so the middle is frame 30.
    select(50, 100);
    expect(info()).toBe('Sel 30-40 (10)  Len 100');
    press('All');
    select(50, 100);
    expect(info()).toBe('Sel 50-100 (50)  Len 100');
    // Too small a selection to zoom to.
    select(10, 11);
    press('Zoom');
    select(50, 100);
    expect(info()).toBe('Sel 50-100 (50)  Len 100');
  });

  it('forgets a selection and zoom that no longer fit the sample', () => {
    select(80, 100);
    press('Zoom');
    sample().data = sample().data.slice(0, 50);
    view.render();
    expect(info()).toBe('Len 50');
    select(50, 100);
    expect(info()).toBe('Sel 25-50 (25)  Len 50');
  });

  it('changes the volume by an amount or a ramp, and says what it needs', async () => {
    const before = Array.from(sample().data);
    press('Amp');
    await answer('50');
    expect(sample().data[10]).toBeCloseTo(before[10]! / 2, 5);
    press('Amp');
    await answer('100 0');
    expect(sample().data[0]).toBeCloseTo(before[0]! / 2, 5);
    expect(sample().data[99]).toBeCloseTo(0, 2);
    press('Amp');
    await answer('1 2 3');
    expect(host.statuses.at(-1)).toBe('Give one or two percentages between 0 and 1000.');
    press('Amp');
    await answer('-5');
    expect(host.statuses.at(-1)).toBe('Give one or two percentages between 0 and 1000.');
    const now = Array.from(sample().data);
    press('Amp');
    await answer(null);
    expect(Array.from(sample().data)).toEqual(now);
  });

  it('filters the selection at a cutoff the sample rate gives meaning to', async () => {
    const before = Array.from(sample().data);
    press('LP');
    const dialog = await vi.waitFor(() => document.querySelector('dialog')!);
    expect(dialog.textContent).toContain('8363 Hz');
    await answer('500');
    expect(Array.from(sample().data)).not.toEqual(before);
    expect(editor.undo()).toBe('lowpass');
    press('HP');
    await answer('0');
    press('HP');
    await answer(null);
    expect(Array.from(sample().data)).toEqual(before);
    press('HP');
    await answer('200');
    expect(editor.undo()).toBe('highpass');
  });

  it('crossfades a loop, and says when it cannot', async () => {
    press('XFade');
    expect(host.statuses.at(-1)).toBe('Crossfade needs a loop.');
    Object.assign(sample(), { loopType: LoopType.Forward, loopStart: 40, loopLength: 40 });
    press('XFade');
    const dialog = await vi.waitFor(() => document.querySelector('dialog')!);
    expect(dialog.querySelector('input')!.value).toBe('10');
    await answer('10');
    expect(host.statuses.at(-1)).toBe('Crossfaded 10 frames into the loop start.');
    Object.assign(sample(), { loopStart: 0, loopLength: 2 });
    press('XFade');
    await answer('4');
    expect(host.statuses.at(-1)).toBe('No room before the loop start to crossfade.');
    press('XFade');
    await answer('none');
    expect(host.statuses).toHaveLength(3);
  });

  it('resamples to any length', async () => {
    press('Rsmp');
    await answer('250');
    expect(sample().data).toHaveLength(250);
    press('Rsmp');
    await answer('250');
    press('Rsmp');
    await answer('0');
    expect(editor.undo()).toBe('resample');
    expect(sample().data).toHaveLength(100);
    // An empty slot has nothing to resample.
    host.slot = 3;
    press('Rsmp');
    await flush();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('leaves an empty slot alone', () => {
    host.slot = 3;
    view.render();
    select(10, 20);
    press('Clear');
    press('Copy');
    press('Cut');
    press('Paste');
    press('XFade');
    expect(editor.song.instruments[0]!.samples).toHaveLength(1);
    expect(host.statuses).toEqual(['Crossfade needs a loop.']);
  });

  it('marks the voices playing this sample', () => {
    const voice = { channel: 0, instrument: 1, sample: 0, note: 49, pos: 25, volEnvTick: 0, panEnvTick: 0 };
    contextOf(overlay()).clear();
    view.showVoices([voice, { ...voice, pos: 75 }, { ...voice, instrument: 2 }, { ...voice, sample: 1 }]);
    const marks = contextOf(overlay()).calls.filter((c) => c.op === 'fillRect');
    expect(marks.map((c) => Math.round(c.args[0] as number))).toEqual([25, 75]);
    // Nothing in an empty slot.
    host.slot = 3;
    contextOf(overlay()).clear();
    view.showVoices([voice]);
    expect(contextOf(overlay()).calls.filter((c) => c.op === 'fillRect')).toEqual([]);
  });

  it('leaves loading, the library and saving to the page', () => {
    press('Load');
    press('Library');
    press('Save');
    press('IFF');
    expect(host.importFile).toHaveBeenCalledOnce();
    expect(host.openLibrary).toHaveBeenCalledOnce();
    expect(vi.mocked(host.saveSample).mock.calls).toEqual([['wav'], ['iff']]);
  });
});
