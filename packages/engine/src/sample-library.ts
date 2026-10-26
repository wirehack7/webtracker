// The built-in sample library: chip waveforms, drums and effects, all made
// here from formulas, so every sound is free to use in any song. Nothing is
// recorded or copied from elsewhere. Every generator is deterministic, so a
// sound is the same each time it is loaded.

import { emptyEnvelope, LoopType, type Envelope, type Instrument, type Sample } from './song.ts';
import { emptyInstrument, generateWave, tuningForRate } from './sample-edit.ts';

export type LibraryCategory = 'chip' | 'drums' | 'fx';

export const LIBRARY_CATEGORIES: readonly LibraryCategory[] = ['chip', 'drums', 'fx'];

export interface LibrarySound {
  /** Stable id, for tests and for remembering the last pick. */
  id: string;
  category: LibraryCategory;
  /** Sample and instrument name, at most 22 characters to fit XM. */
  name: string;
  /** Makes a fresh instrument holding the sound as its only sample. */
  make(): Instrument;
}

/** Rate the drums and effects are made at; relative note 12 plays them at this rate on C-4. */
export const LIBRARY_DRUM_RATE = 16726;
/** Frames per cycle of the looped chip waves: 32 frames at 8363 Hz sound at C-4. */
const CYCLE = 32;

/** Rounds to 8-bit levels so the sound saves as an 8-bit sample without any change. */
const to8 = (v: number) => Math.max(-128, Math.min(127, Math.round(v * 127))) / 128 || 0;

function noise(seed = 0x2545f491): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 - 1;
  };
}

function looped(name: string, data: Float32Array, volume = 48): Sample {
  return { name, data, loopStart: 0, loopLength: data.length, loopType: LoopType.Forward, volume, finetune: 0, panning: 128, relativeNote: 0 };
}

function oneShot(name: string, data: Float32Array, volume = 56): Sample {
  return { name, data, loopStart: 0, loopLength: 0, loopType: LoopType.None, volume, panning: 128, ...tuningForRate(LIBRARY_DRUM_RATE) };
}

function envelope(points: [number, number][], options: Partial<Envelope> = {}): Envelope {
  return { ...emptyEnvelope(), enabled: true, points: points.map(([x, y]) => ({ x, y })), ...options };
}

/** A short attack, a little decay and a sustain; released notes fade out. */
const PLUCK = (): Partial<Instrument> => ({
  volumeEnvelope: envelope(
    [
      [0, 64],
      [6, 48],
      [20, 40],
    ],
    { sustain: true, sustainPoint: 2 },
  ),
  fadeout: 1024,
});

function instrument(sample: Sample, options: Partial<Instrument> = {}): Instrument {
  return { ...emptyInstrument(sample.name), samples: [sample], ...options };
}

/**
 * Frames for `seconds` of sound at the drum rate, `frame` gets the time in
 * seconds. The result peaks just under full scale, so nothing clips.
 */
function render(seconds: number, frame: (t: number) => number): Float32Array {
  const raw = Float32Array.from({ length: Math.round(seconds * LIBRARY_DRUM_RATE) }, (_, i) => frame(i / LIBRARY_DRUM_RATE));
  const peak = raw.reduce((max, v) => Math.max(max, Math.abs(v)), 0) || 1;
  return raw.map((v) => to8((v / peak) * 0.95));
}

/** A sine whose frequency follows `hz(t)`, as phase so the sweep is smooth. */
function sweep(hz: (t: number) => number, shape: (phase: number) => number = (p) => Math.sin(2 * Math.PI * p)): (t: number) => number {
  let phase = 0;
  return (t) => {
    phase = (phase + hz(t) / LIBRARY_DRUM_RATE) % 1;
    return shape(phase);
  };
}

const squareOf = (p: number) => (p < 0.5 ? 1 : -1);

/** One-pole low-pass run around a looped wave three times, so its end joins its start. */
function soften(wave: number[], amount: number): Float32Array {
  let y = 0;
  const out = wave.map(() => 0);
  for (let pass = 0; pass < 3; pass++) {
    wave.forEach((x, i) => {
      y += amount * (x - y);
      out[i] = y;
    });
  }
  return Float32Array.from(out, to8);
}

/** `cycles` cycles of a pulse whose width sweeps thin, square and back, looped. */
function pwm(cycles: number, min: number, max: number): Float32Array {
  const wave: number[] = [];
  for (let c = 0; c < cycles; c++) {
    const width = min + (max - min) * (1 - Math.abs((2 * c) / cycles - 1));
    for (let i = 0; i < CYCLE; i++) wave.push(i / CYCLE < width ? 0.75 : -0.75);
  }
  return soften(wave, 0.7);
}

/** One cycle as the sum of sine harmonics, given as [harmonic, level]. */
function additive(partials: [number, number][]): Float32Array {
  const raw = Array.from({ length: CYCLE }, (_, i) => partials.reduce((sum, [h, level]) => sum + level * Math.sin((2 * Math.PI * h * i) / CYCLE), 0));
  const peak = Math.max(...raw.map(Math.abs));
  return Float32Array.from(raw, (v) => to8((v / peak) * 0.75));
}

/** A triangle in 16 steps, the way 4-bit chips make it. */
function steppedTriangle(): Float32Array {
  return Float32Array.from({ length: CYCLE }, (_, i) => {
    const level = i < CYCLE / 2 ? i : CYCLE - 1 - i;
    return to8((level / 15) * 1.5 - 0.75);
  });
}

/**
 * Noise from a 15-bit shift register that repeats after `period` steps:
 * short periods give the metallic buzz of chip noise channels.
 */
function lfsrNoise(period: number, stepFrames: number): Float32Array {
  let reg = 1;
  const steps: number[] = [];
  for (let i = 0; i < period; i++) {
    const bit = (reg ^ (reg >> 1)) & 1;
    reg = (reg >> 1) | (bit << 14);
    steps.push(reg & 1 ? 0.6 : -0.6);
  }
  return Float32Array.from({ length: period * stepFrames }, (_, i) => to8(steps[Math.floor(i / stepFrames)]!));
}

function whiteNoise(frames: number, level = 0.6): Float32Array {
  const random = noise(0x1234567);
  return Float32Array.from({ length: frames }, () => to8(random() * level));
}

/** Six detuned squares mixed, the classic recipe for a metal cymbal tone. */
function metal(t: number): number {
  const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
  return ratios.reduce((sum, r) => sum + squareOf((t * 100 * r) % 1), 0) / ratios.length;
}

/** Noise through a one-pole high-pass, brighter as `amount` nears 1. */
function hissy(amount: number, seed?: number): () => number {
  const random = noise(seed);
  let low = 0;
  return () => {
    const x = random();
    low += (1 - amount) * (x - low);
    return x - low;
  };
}

function dampedNoise(amount: number, seed?: number): () => number {
  const random = noise(seed);
  let low = 0;
  return () => {
    low += amount * (random() - low);
    return low;
  };
}

const drum = (id: string, name: string, data: () => Float32Array, volume = 56): LibrarySound => ({
  id,
  category: 'drums',
  name,
  make: () => instrument(oneShot(name, data(), volume)),
});

const fx = (id: string, name: string, data: () => Float32Array, volume = 48): LibrarySound => ({
  id,
  category: 'fx',
  name,
  make: () => instrument(oneShot(name, data(), volume)),
});

const chip = (id: string, name: string, data: () => Float32Array, volume = 48): LibrarySound => ({
  id,
  category: 'chip',
  name,
  make: () => instrument(looped(name, data(), volume), PLUCK()),
});

export const SAMPLE_LIBRARY: readonly LibrarySound[] = [
  // ---- Chip waves: looped, one cycle of 32 frames is C-4 unless noted.
  chip('square', 'Square 50%', () => generateWave('square'), 40),
  chip('pulse25', 'Pulse 25%', () => generateWave('pulse25'), 40),
  chip('pulse12', 'Pulse 12.5%', () => generateWave('pulse12'), 40),
  chip('triangle', 'Triangle', () => generateWave('triangle'), 56),
  chip('triangle4', 'Triangle 4-bit', steppedTriangle, 52),
  chip('saw', 'Saw', () => generateWave('saw'), 40),
  chip('roundsaw', 'Round saw', () => soften(Array.from({ length: CYCLE }, (_, i) => 0.8 - (1.6 * i) / CYCLE), 0.3), 48),
  chip('sine', 'Sine', () => generateWave('sine'), 52),
  chip('softsquare', 'Soft square', () =>
    soften(Array.from({ length: CYCLE }, (_, i) => (i < CYCLE / 2 ? 1 : -1) * 0.85 * Math.exp(-(i % (CYCLE / 2)) / 9)), 0.6), 48),
  chip('pwmslow', 'PWM slow', () => pwm(48, 0.1, 0.5), 44),
  chip('pwmfast', 'PWM fast', () => pwm(12, 0.15, 0.5), 44),
  chip('organ', 'Organ', () => additive([[1, 1], [2, 0.5], [3, 0.35], [4, 0.2], [6, 0.12]]), 48),
  chip('hollow', 'Hollow', () => additive([[1, 1], [3, 0.45], [5, 0.2], [7, 0.1]]), 48),
  chip('noiseloop', 'Noise loop', () => whiteNoise(8192), 40),
  chip('metalnoise', 'Metal noise', () => lfsrNoise(93, 4), 36),

  // ---- Drums: one-shots at 16726 Hz, C-4 plays them as made.
  drum('kick', 'Kick', () => {
    const tone = sweep((t) => 45 + 75 * Math.exp(-t * 30));
    return render(0.22, (t) => tone(t) * Math.exp(-t * 12));
  }),
  drum('kick808', 'Deep kick', () => {
    const tone = sweep((t) => 42 + 110 * Math.exp(-t * 40));
    return render(0.6, (t) => tone(t) * Math.exp(-t * 5) * Math.min(1, t * 2000));
  }),
  drum('chipkick', 'Chip kick', () => {
    const tone = sweep((t) => 50 + 400 * Math.exp(-t * 45), squareOf);
    return render(0.15, (t) => tone(t) * 0.7 * Math.exp(-t * 18));
  }, 48),
  drum('snare', 'Snare', () => {
    const body = dampedNoise(0.35);
    return render(0.2, (t) => Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 35) * 0.45 + body() * 1.4 * Math.exp(-t * 18));
  }, 44),
  drum('chipsnare', 'Chip snare', () => {
    const tone = sweep((t) => 160 + 300 * Math.exp(-t * 60), squareOf);
    const random = noise(99);
    return render(0.16, (t) => (t < 0.02 ? tone(t) * 0.6 : 0) + random() * 0.6 * Math.exp(-t * 20));
  }, 40),
  drum('clap', 'Clap', () => {
    const body = hissy(0.4, 7);
    return render(0.3, (t) => {
      const burst = t < 0.03 ? Math.exp(-((t % 0.01) * 300)) : Math.exp(-(t - 0.03) * 14);
      return body() * burst;
    });
  }, 36),
  drum('hatclosed', 'Closed hat', () => {
    const body = hissy(0.85, 3);
    return render(0.06, (t) => (body() * 0.6 + metal(t) * 0.4) * Math.exp(-t * 70));
  }, 32),
  drum('hatopen', 'Open hat', () => {
    const body = hissy(0.85, 4);
    return render(0.4, (t) => (body() * 0.6 + metal(t) * 0.4) * Math.exp(-t * 9));
  }, 28),
  drum('shaker', 'Shaker', () => {
    const body = dampedNoise(0.5, 5);
    return render(0.08, (t) => body() * Math.min(1, t * 200) * Math.exp(-t * 50));
  }, 22),
  drum('tomlow', 'Low tom', () => {
    const tone = sweep((t) => 90 + 60 * Math.exp(-t * 12));
    return render(0.4, (t) => tone(t) * Math.exp(-t * 8));
  }),
  drum('tomhigh', 'High tom', () => {
    const tone = sweep((t) => 160 + 90 * Math.exp(-t * 14));
    return render(0.3, (t) => tone(t) * Math.exp(-t * 10));
  }),
  drum('rim', 'Rimshot', () => render(0.05, (t) => (Math.sin(2 * Math.PI * 820 * t) * 0.6 + squareOf((t * 1700) % 1) * 0.2) * Math.exp(-t * 90)), 40),
  drum('cowbell', 'Cowbell', () => {
    const low = sweep(() => 540, squareOf);
    const high = sweep(() => 800, squareOf);
    return render(0.3, (t) => (low(t) + high(t)) * 0.3 * Math.exp(-t * 12));
  }, 36),
  drum('crash', 'Crash', () => {
    const body = hissy(0.7, 11);
    return render(1.2, (t) => (body() * 0.65 + metal(t) * 0.35) * Math.exp(-t * 3) * Math.min(1, t * 1000));
  }, 28),

  // ---- Effects: one-shots at 16726 Hz.
  fx('zap', 'Zap', () => {
    const tone = sweep((t) => 100 + 2000 * Math.exp(-t * 25), squareOf);
    return render(0.25, (t) => tone(t) * 0.6 * Math.exp(-t * 8));
  }),
  fx('blip', 'Blip', () => {
    const tone = sweep((t) => 600 + 4000 * t, squareOf);
    return render(0.06, (t) => tone(t) * 0.5 * Math.exp(-t * 30));
  }),
  fx('coin', 'Coin', () => {
    const tone = sweep((t) => (t < 0.06 ? 988 : 1319), squareOf);
    return render(0.35, (t) => tone(t) * 0.5 * (t < 0.06 ? 1 : Math.exp(-(t - 0.06) * 9)));
  }),
  fx('riser', 'Riser', () => {
    const random = noise(21);
    let low = 0;
    return render(1.5, (t) => {
      low += (0.05 + 0.5 * (t / 1.5)) * (random() - low);
      return low * 1.5 * (t / 1.5);
    });
  }, 40),
  fx('boom', 'Boom', () => {
    const random = noise(33);
    let low = 0;
    return render(0.9, (t) => {
      low += (0.3 * Math.exp(-t * 4) + 0.02) * (random() - low);
      return low * 2 * Math.exp(-t * 3);
    });
  }),
];

export function librarySound(id: string): LibrarySound | undefined {
  return SAMPLE_LIBRARY.find((sound) => sound.id === id);
}
