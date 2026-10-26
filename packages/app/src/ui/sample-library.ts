// The Sample library dialog: the built-in sounds by category, each with a
// small waveform. A tap plays a sound; the buttons put it into the current
// sample slot or make it the current instrument.

import { LIBRARY_CATEGORIES, SAMPLE_LIBRARY, type Instrument, type LibraryCategory, type LibrarySound, type Sample } from '@webtracker/engine';
import { msg, t } from '../i18n/i18n.ts';
import { cssColor, el } from './widgets.ts';

export const CATEGORY_LABELS: Record<LibraryCategory, string> = {
  chip: msg('Chip'),
  drums: msg('Drums'),
  fx: msg('FX'),
};

/** What each sound is good for, shown under the list. */
export const SOUND_DESCRIPTIONS: Record<string, string> = {
  square: msg('The hollow chip square, for leads and bass.'),
  pulse25: msg('A nasal pulse, the classic chip lead.'),
  pulse12: msg('A thin, reedy pulse for arpeggios and echoes.'),
  triangle: msg('A soft triangle for bass lines and flutes.'),
  triangle4: msg('A triangle in 16 steps, buzzy like a console bass channel.'),
  saw: msg('A bright saw for leads and fat chords.'),
  roundsaw: msg('A saw with its edge rounded off, warm for pads and bass.'),
  sine: msg('A pure sine for sub bass and soft bells.'),
  softsquare: msg('A square that sags like a chip through a capacitor, round and woody.'),
  pwmslow: msg('A pulse whose width sweeps slowly: the moving lead of the C64 in one loop.'),
  pwmfast: msg('A quicker width sweep, for chorus-like chords and bass.'),
  organ: msg('Sine harmonics stacked like organ drawbars.'),
  hollow: msg('Only odd harmonics: a clarinet-like tone.'),
  noiseloop: msg('Looped white noise for wind, surf and hand-made drums.'),
  metalnoise: msg('Short chip noise that repeats: a metallic buzz with a pitch.'),
  kick: msg('A soft sine kick that falls from 120 to 45 Hz.'),
  kick808: msg('A long, booming kick in the style of drum machines.'),
  chipkick: msg('A square that drops fast: the punchy kick of chip music.'),
  snare: msg('A snare of a tone and soft noise.'),
  chipsnare: msg('A square pitch drop and noise, as on 8-bit consoles.'),
  clap: msg('Three quick bursts of noise and a tail.'),
  hatclosed: msg('A short, ticking hi-hat.'),
  hatopen: msg('A hi-hat left ringing.'),
  shaker: msg('A soft brush of noise for 16th notes.'),
  tomlow: msg('A round tom that falls in pitch.'),
  tomhigh: msg('A higher tom for fills.'),
  rim: msg('A short, woody click.'),
  cowbell: msg('Two squares a fifth apart, as drum machines make it.'),
  crash: msg('A long crash cymbal that hisses away.'),
  zap: msg('A laser zap: a square falling fast.'),
  blip: msg('A short rising blip for menus and accents.'),
  coin: msg('Two quick notes up, the pickup sound of games.'),
  riser: msg('Noise that swells and rises, for build-ups.'),
  boom: msg('A deep explosion of falling noise.'),
};

export interface SampleLibraryHost {
  /** Plays a sound on C-4 so it can be heard before loading. */
  audition(sample: Sample): void;
  /** Puts the sound into the current sample slot. */
  loadSample(sample: Sample): void;
  /** Replaces the current instrument with the sound and its envelope. */
  loadInstrument(instrument: Instrument): void;
}

export interface SampleLibrary {
  open(): void;
}

/** Draws the start of a sound: a few cycles of a looped wave, all of a one-shot. */
function drawThumb(canvas: HTMLCanvasElement, data: Float32Array, looped: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = cssColor('--pat-vol', '#7fff8f');
  ctx.lineWidth = 1;
  ctx.beginPath();
  const frames = looped ? Math.min(data.length, 128) : data.length;
  for (let x = 0; x < width; x++) {
    const from = Math.floor((x / width) * frames);
    const to = Math.max(from + 1, Math.floor(((x + 1) / width) * frames));
    let lo = 1;
    let hi = -1;
    for (let i = from; i < to; i++) {
      const v = data[i] ?? 0;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    ctx.moveTo(x + 0.5, (0.5 - hi * 0.45) * height);
    ctx.lineTo(x + 0.5, (0.5 - lo * 0.45) * height + 1);
  }
  ctx.stroke();
}

export function mountSampleLibrary(dialog: HTMLDialogElement, host: SampleLibraryHost): SampleLibrary {
  const tabs = dialog.querySelector<HTMLElement>('.sample-lib-tabs')!;
  const list = dialog.querySelector<HTMLOListElement>('.list')!;
  const info = dialog.querySelector<HTMLElement>('.sample-lib-info')!;
  const loadSample = dialog.querySelector<HTMLButtonElement>('#sample-lib-load')!;
  const loadInstrument = dialog.querySelector<HTMLButtonElement>('#sample-lib-instrument')!;
  let category: LibraryCategory = 'chip';
  let picked: LibrarySound | null = null;
  /** Each sound is made once for its waveform and for playing it. */
  const made = new Map<string, Instrument>();
  const make = (sound: LibrarySound) => {
    let ins = made.get(sound.id);
    if (!ins) made.set(sound.id, (ins = sound.make()));
    return ins;
  };
  // Every load gets its own copy, so undo and later edits never share data.
  const fresh = (sound: LibrarySound) => sound.make();

  const tabButtons = LIBRARY_CATEGORIES.map((c) => {
    const b = el('button', 'btn', t(CATEGORY_LABELS[c]));
    b.type = 'button';
    b.dataset.category = c;
    b.addEventListener('click', () => {
      category = c;
      fill();
    });
    return b;
  });
  tabs.replaceChildren(...tabButtons);

  function showPicked(): void {
    for (const li of list.children) li.setAttribute('aria-selected', String((li as HTMLElement).dataset.id === picked?.id));
    loadSample.disabled = loadInstrument.disabled = !picked;
    info.textContent = picked ? t(SOUND_DESCRIPTIONS[picked.id] ?? '') : t('Tap a sound to hear it, then load it into the current sample slot or make it the instrument.');
  }

  function fill(): void {
    for (const b of tabButtons) b.setAttribute('aria-pressed', String(b.dataset.category === category));
    const sounds = SAMPLE_LIBRARY.filter((s) => s.category === category);
    if (picked && picked.category !== category) picked = null;
    list.replaceChildren(
      ...sounds.map((sound) => {
        const li = document.createElement('li');
        li.dataset.id = sound.id;
        const sample = make(sound).samples[0]!;
        const thumb = document.createElement('canvas');
        thumb.className = 'sample-lib-wave';
        thumb.width = 64;
        thumb.height = 16;
        thumb.setAttribute('aria-hidden', 'true');
        drawThumb(thumb, sample.data, sample.loopLength > 0);
        const name = el('span', 'name', sound.name);
        name.translate = false;
        li.append(thumb, name);
        return li;
      }),
    );
    showPicked();
  }

  list.addEventListener('click', (event) => {
    const li = (event.target as HTMLElement).closest('li');
    const sound = SAMPLE_LIBRARY.find((s) => s.id === li?.dataset.id);
    if (!sound) return;
    picked = sound;
    showPicked();
    host.audition(make(sound).samples[0]!);
  });
  list.addEventListener('dblclick', () => {
    if (picked) loadSample.click();
  });
  loadSample.addEventListener('click', () => {
    if (!picked) return;
    host.loadSample(fresh(picked).samples[0]!);
    dialog.close();
  });
  loadInstrument.addEventListener('click', () => {
    if (!picked) return;
    host.loadInstrument(fresh(picked));
    dialog.close();
  });
  // A tap on the backdrop closes the dialog.
  dialog.addEventListener('click', (event) => {
    const r = dialog.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (event.target === dialog && !inside) dialog.close();
  });

  fill();
  return {
    open() {
      fill();
      dialog.showModal();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    },
  };
}
