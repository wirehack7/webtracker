/**
 * "Pixel Sunrise", the demo song that comes with the tracker. Everything in
 * it is generated here: chip waveforms, drums made from noise and sine
 * sweeps, and four channels of patterns that try out most of the XM effects
 * (arpeggio, portamento, vibrato, tremolo, tremor, volume and panning
 * slides, retriggers, note cut and delay, pattern loop, global volume) and
 * instrument envelopes and auto-vibrato. Free to use and remix.
 */

import { writeCell } from './edit.ts';
import { generateWave } from './sample-edit.ts';
import { emptyEnvelope, emptyPattern, LoopType, NOTE_KEY_OFF, type Cell, type Envelope, type Instrument, type Pattern, type Sample, type Song } from './song.ts';

export const DEMO_SONG_TITLE = 'Pixel Sunrise';

// ---- Instruments ---------------------------------------------------------------

const LEAD = 1;
const CHORD = 2;
const BASS = 3;
const TRI = 4;
const KICK = 5;
const SNARE = 6;
const HAT = 7;
const PAD = 8;

/** Rate the drum samples are made at; relative note 12 plays them at this rate for C-4. */
const DRUM_RATE = 16726;

/** Rounds to 8-bit levels so the song saves as XM without any change. */
const to8 = (v: number) => Math.max(-128, Math.min(127, Math.round(v * 127))) / 128 || 0;

function envelope(points: [number, number][], options: Partial<Envelope> = {}): Envelope {
  return { ...emptyEnvelope(), enabled: true, points: points.map(([x, y]) => ({ x, y })), ...options };
}

function sample(name: string, data: Float32Array, options: Partial<Sample> = {}): Sample {
  return {
    name,
    data,
    loopStart: 0,
    loopLength: data.length,
    loopType: LoopType.Forward,
    volume: 64,
    finetune: 0,
    panning: 128,
    relativeNote: 0,
    ...options,
  };
}

function instrument(name: string, s: Sample | null, options: Partial<Instrument> = {}): Instrument {
  return {
    name,
    samples: s ? [s] : [],
    keymap: new Uint8Array(96),
    volumeEnvelope: emptyEnvelope(),
    panningEnvelope: emptyEnvelope(),
    fadeout: 0,
    vibratoType: 0,
    vibratoSweep: 0,
    vibratoDepth: 0,
    vibratoRate: 0,
    ...options,
  };
}

function drum(length: number, frame: (t: number, random: () => number) => number): Float32Array {
  let state = 0x2545f491;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  return Float32Array.from({ length: Math.round(length * DRUM_RATE) }, (_, i) => to8(frame(i / DRUM_RATE, random)));
}

function kick(): Float32Array {
  let phase = 0;
  return drum(0.2, (t) => {
    // A soft sine thump, falling from 120 Hz to 45 Hz.
    phase += (45 + 75 * Math.exp(-t * 30)) / DRUM_RATE;
    return Math.sin(2 * Math.PI * phase) * Math.exp(-t * 12);
  });
}

function snare(): Float32Array {
  let low = 0;
  return drum(0.18, (t, random) => {
    // Low-passed noise keeps the snare from hissing.
    low += 0.35 * (random() * 2 - 1 - low);
    const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 35);
    return tone * 0.45 + low * 1.4 * Math.exp(-t * 18);
  });
}

function hat(): Float32Array {
  let low = 0;
  return drum(0.05, (t, random) => {
    low += 0.5 * (random() * 2 - 1 - low);
    return low * 0.8 * Math.exp(-t * 70);
  });
}

/**
 * One-pole low-pass run around a looped wave, so the end joins the start.
 * Rounds off the hard edges that make raw chip waves sound harsh.
 */
function soften(wave: number[], amount: number): Float32Array {
  let y = 0;
  const out = new Array<number>(wave.length).fill(0);
  for (let pass = 0; pass < 3; pass++) {
    wave.forEach((x, i) => {
      y += amount * (x - y);
      out[i] = y;
    });
  }
  return Float32Array.from(out, to8);
}

const CYCLE = 32;

/**
 * A pulse whose width sweeps from thin to square and back over `cycles`
 * cycles of 32 frames: pulse width modulation baked into one looped sample.
 */
function pwmWave(cycles: number): Float32Array {
  const wave: number[] = [];
  for (let c = 0; c < cycles; c++) {
    const width = 0.14 + 0.34 * (1 - Math.abs((2 * c) / cycles - 1));
    for (let i = 0; i < CYCLE; i++) wave.push(i / CYCLE < width ? 0.7 : -0.7);
  }
  return soften(wave, 0.5);
}

/** A saw that gets rounder and brighter again over `cycles` cycles. */
function morphSaw(cycles: number): Float32Array {
  const wave: number[] = [];
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < CYCLE; i++) wave.push(0.8 - (1.6 * i) / CYCLE);
  }
  const amounts = Array.from({ length: cycles }, (_, c) => 0.25 + 0.2 * Math.sin((Math.PI * c) / cycles));
  let y = 0;
  const out = wave.map(() => 0);
  for (let pass = 0; pass < 3; pass++) {
    wave.forEach((x, i) => {
      y += amounts[Math.floor(i / CYCLE)]! * (x - y);
      out[i] = y;
    });
  }
  return Float32Array.from(out, to8);
}

/** A square whose halves sag towards zero, like a chip output through a capacitor. */
function droopSquare(): Float32Array {
  const wave = Array.from({ length: CYCLE }, (_, i) => {
    const half = i < CYCLE / 2 ? 1 : -1;
    return half * 0.85 * Math.exp(-(i % (CYCLE / 2)) / 9);
  });
  return soften(wave, 0.6);
}

function instruments(): Instrument[] {
  const oneShot = { loopType: LoopType.None, loopLength: 0, relativeNote: 12 };
  return [
    instrument('Lead PWM', sample('PWM pulse', pwmWave(24), { volume: 54 }), {
      volumeEnvelope: envelope(
        [
          [0, 56],
          [6, 46],
          [24, 40],
          [48, 0],
        ],
        { sustain: true, sustainPoint: 2 },
      ),
      fadeout: 600,
      // Delayed auto-vibrato on every lead note.
      vibratoType: 0,
      vibratoSweep: 64,
      vibratoDepth: 2,
      vibratoRate: 20,
    }),
    instrument('Chord soft saw', sample('Morphing saw', morphSaw(12), { volume: 36 }), {
      volumeEnvelope: envelope(
        [
          [0, 60],
          [4, 48],
          [16, 36],
          [32, 0],
        ],
        { sustain: true, sustainPoint: 2 },
      ),
      fadeout: 1024,
    }),
    instrument('Bass droop square', sample('Droop square', droopSquare(), { volume: 54 }), {
      volumeEnvelope: envelope(
        [
          [0, 64],
          [8, 50],
          [20, 0],
        ],
        { sustain: true, sustainPoint: 1 },
      ),
      fadeout: 2048,
    }),
    instrument('Triangle', sample('Triangle', generateWave('triangle'), { volume: 52 })),
    instrument('Kick', sample('Kick', kick(), { ...oneShot, volume: 56 })),
    instrument('Snare', sample('Snare', snare(), { ...oneShot, volume: 40 })),
    instrument('Shaker', sample('Shaker', hat(), { ...oneShot, volume: 24 })),
    instrument('Pad soft saw', sample('Round saw', soften(Array.from({ length: CYCLE }, (_, i) => 0.8 - (1.6 * i) / CYCLE), 0.3), { volume: 30 }), {
      // Slow swell, and a looping pan envelope that sweeps it left and right.
      volumeEnvelope: envelope(
        [
          [0, 0],
          [24, 48],
          [64, 36],
          [120, 0],
        ],
        { sustain: true, sustainPoint: 2 },
      ),
      panningEnvelope: envelope(
        [
          [0, 32],
          [24, 10],
          [72, 54],
          [96, 32],
        ],
        { loop: true, loopStart: 0, loopEnd: 3 },
      ),
      fadeout: 300,
    }),
    // Instrument names as liner notes, the way scene musicians have always done it.
    instrument('----------------------', null),
    instrument(' Pixel Sunrise', null),
    instrument(' 4ch chiptune demo', null),
    instrument(' all sounds generated', null),
    instrument(' free to play & remix', null),
    instrument(' made with webtracker', null),
  ];
}

// ---- Pattern helpers -----------------------------------------------------------

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/** XM note number from a name like "A-4" or "C#5". */
function noteNumber(name: string): number {
  const semitone = NAMES.indexOf(name.slice(0, 2));
  const octave = Number(name.slice(2));
  if (semitone < 0 || !Number.isInteger(octave)) throw new Error(`bad note ${name}`);
  return octave * 12 + semitone + 1;
}

/**
 * The tune is written in A minor and played in E minor: the lower register
 * keeps the chip waves warm instead of shrill.
 */
const KEY = -5;

/** A melodic note, moved into the song's key. */
const n = (name: string) => noteNumber(name) + KEY;

const OFF = NOTE_KEY_OFF;

/** Volume column bytes. */
const vol = (v: number) => 0x10 + v;
const volSlideDown = (x: number) => 0x60 + x;
const vibSpeed = (x: number) => 0xa0 + x;
const vibDepth = (x: number) => 0xb0 + x;
const panLeft = (x: number) => 0xd0 + x;
const panRight = (x: number) => 0xe0 + x;
const volPorta = (x: number) => 0xf0 + x;

/** Effect numbers. */
const ARP = 0x0;
const PORTA_UP = 0x1;
const PORTA_DOWN = 0x2;
const TONE_PORTA = 0x3;
const VIBRATO = 0x4;
const VIBRATO_SLIDE = 0x6;
const TREMOLO = 0x7;
const PAN = 0x8;
const OFFSET = 0x9;
const VOL_SLIDE = 0xa;
const EXTENDED = 0xe;
const SPEED = 0xf;
const GLOBAL_VOL = 0x10;
const GLOBAL_SLIDE = 0x11;
const KEY_OFF = 0x14;
const PAN_SLIDE = 0x19;
const RETRIG = 0x1b;
const TREMOR = 0x1d;

const CH_LEAD = 0;
const CH_HARM = 1;
const CH_BASS = 2;
const CH_DRUM = 3;
const CHANNELS = 4;

interface Chord {
  root: string;
  /** Arpeggio parameter: minor 0x37, major 0x47. */
  arp: number;
}

const VERSE: Chord[] = [
  { root: 'A-', arp: 0x37 },
  { root: 'F-', arp: 0x47 },
  { root: 'C-', arp: 0x47 },
  { root: 'G-', arp: 0x47 },
];
const BRIDGE: Chord[] = [
  { root: 'D-', arp: 0x37 },
  { root: 'G-', arp: 0x47 },
  { root: 'C-', arp: 0x47 },
  { root: 'E-', arp: 0x47 },
];

class Builder {
  readonly pattern: Pattern = emptyPattern(64, CHANNELS);
  constructor(private readonly song: Song) {}

  put(row: number, channel: number, cell: Partial<Cell>): void {
    if (row < 0 || row >= 64) return;
    writeCell(this.song, this.pattern, row, channel, cell);
  }

  /** Sets only the effect, keeping whatever note the cell has. */
  fx(row: number, channel: number, effect: number, param: number): void {
    this.put(row, channel, { effect, param });
  }

  fxRange(from: number, to: number, channel: number, effect: number, param: number): void {
    for (let row = from; row <= to; row++) this.fx(row, channel, effect, param);
  }
}

type Phrase = [row: number, note: string, length: number][];

/** Writes a melody; notes of 6 rows or more get vibrato after their attack, or every note an arpeggio. */
function melody(b: Builder, channel: number, ins: number, phrase: Phrase, options: { transpose?: number; volume?: number; vibrato?: number; arp?: number } = {}): void {
  for (const [row, name, length] of phrase) {
    b.put(row, channel, { note: n(name) + (options.transpose ?? 0), instrument: ins, volume: vol(options.volume ?? 64) });
    if (options.arp !== undefined) b.fxRange(row, row + length - 1, channel, ARP, options.arp);
    else if (length >= 6) b.fxRange(row + 3, row + length - 1, channel, VIBRATO, options.vibrato ?? 0x45);
  }
}

/** Chord arpeggio on every row, re-struck each beat. */
function arpeggios(b: Builder, chords: Chord[], octave: number, ins = CHORD, wide = false): void {
  chords.forEach((chord, bar) => {
    for (let r = 0; r < 16; r++) {
      const row = bar * 16 + r;
      // The second half of a bar opens up to fifth + octave in the wide variant.
      const arp = wide && r >= 8 ? 0x7c : chord.arp;
      if (r % 4 === 0) b.put(row, CH_HARM, { note: n(chord.root + octave), instrument: ins, volume: vol(r === 0 ? 48 : 34), effect: ARP, param: arp });
      else b.fx(row, CH_HARM, ARP, arp);
    }
  });
}

/** Octave-jumping eighth-note bass. */
function bassline(b: Builder, chords: Chord[], ins = BASS): void {
  chords.forEach((chord, bar) => {
    for (let r = 0; r < 16; r += 2) {
      const octave = r % 4 === 0 ? 2 : 3;
      b.put(bar * 16 + r, CH_BASS, { note: n(chord.root + octave), instrument: ins, volume: vol(r % 4 === 0 ? 64 : 44) });
    }
  });
}

function drums(b: Builder, variant: 'basic' | 'busy' | 'four' = 'basic', fill = true): void {
  for (let bar = 0; bar < 4; bar++) {
    const base = bar * 16;
    const kicks = variant === 'four' ? [0, 4, 8, 12] : bar % 2 ? [0, 8, 10] : [0, 8];
    for (let r = 0; r < 16; r += 2) b.put(base + r, CH_DRUM, { note: noteNumber('C-5'), instrument: HAT, volume: vol(r % 4 === 2 ? 26 : 14) });
    for (const r of kicks) b.put(base + r, CH_DRUM, { note: noteNumber('C-4'), instrument: KICK, volume: vol(64) });
    for (const r of [4, 12]) b.put(base + r, CH_DRUM, { note: noteNumber('C-4'), instrument: SNARE, volume: vol(64) });
    if (variant === 'busy') {
      // A ghost snare half a row late (note delay) and a short open hat.
      b.put(base + 7, CH_DRUM, { note: noteNumber('D-4'), instrument: SNARE, volume: vol(20), effect: EXTENDED, param: 0xd3 });
      b.put(base + 14, CH_DRUM, { note: noteNumber('A-4'), instrument: HAT, volume: vol(44) });
    }
  }
  if (fill) {
    [28, 36, 46, 60].forEach((v, i) => b.put(60 + i, CH_DRUM, { note: noteNumber('C-4'), instrument: SNARE, volume: vol(v) }));
  }
}

// ---- Melodies ------------------------------------------------------------------

const THEME_A: Phrase = [
  [0, 'A-4', 6],
  [6, 'C-5', 2],
  [8, 'E-5', 4],
  [12, 'D-5', 2],
  [14, 'C-5', 2],
  [16, 'C-5', 6],
  [22, 'A-4', 2],
  [24, 'F-4', 4],
  [28, 'A-4', 2],
  [30, 'C-5', 2],
  [32, 'E-5', 6],
  [38, 'G-5', 2],
  [40, 'E-5', 4],
  [44, 'D-5', 2],
  [46, 'C-5', 2],
  [48, 'D-5', 8],
  [56, 'B-4', 4],
  [60, 'G-4', 2],
  [62, 'B-4', 2],
];

const THEME_B: Phrase = [
  [0, 'D-5', 2],
  [2, 'F-5', 2],
  [4, 'A-5', 2],
  [6, 'F-5', 2],
  [8, 'D-5', 4],
  [12, 'E-5', 2],
  [14, 'F-5', 2],
  [16, 'G-5', 8],
  [24, 'D-5', 2],
  [26, 'G-5', 2],
  [28, 'B-5', 2],
  [30, 'D-6', 2],
  [32, 'C-6', 8],
  [40, 'B-5', 2],
  [42, 'A-5', 2],
  [44, 'G-5', 2],
  [46, 'E-5', 2],
  [48, 'G#5', 8],
  [56, 'B-5', 8],
];

// ---- Patterns ------------------------------------------------------------------

/** Global volume fades in; pad, triangle bass and a lead that slides in. */
function intro(song: Song): Pattern {
  const b = new Builder(song);
  b.put(0, CH_DRUM, { effect: GLOBAL_VOL, param: 0x00 });
  b.fxRange(0, 15, CH_LEAD, GLOBAL_SLIDE, 0x10);

  // Pad chords that glide from root to root with tone portamento.
  b.put(0, CH_HARM, { note: n('A-3'), instrument: PAD, volume: vol(64) });
  b.put(16, CH_HARM, { note: n('F-3'), effect: TONE_PORTA, param: 0x08 });
  b.put(32, CH_HARM, { note: n('C-4'), effect: TONE_PORTA, param: 0x08 });
  b.put(48, CH_HARM, { note: n('G-3'), effect: TONE_PORTA, param: 0x08 });
  for (const start of [16, 32, 48]) b.fxRange(start + 1, start + 5, CH_HARM, TONE_PORTA, 0x00);
  // Volume column vibrato on the held pad.
  b.put(8, CH_HARM, { volume: vibSpeed(5) });
  for (let r = 9; r < 15; r++) b.put(r, CH_HARM, { volume: vibDepth(4) });

  ['A-2', 'F-2', 'C-3', 'G-2'].forEach((root, bar) => {
    b.put(bar * 16, CH_BASS, { note: n(root), instrument: TRI, volume: vol(56) });
    b.put(bar * 16 + 8, CH_BASS, { note: n(root), instrument: TRI, volume: vol(40) });
  });
  // The last bass note bends upwards.
  b.fxRange(58, 63, CH_BASS, PORTA_UP, 0x04);

  // Hats grow louder, then the kick comes in.
  for (let r = 16; r < 32; r += 4) b.put(r, CH_DRUM, { note: noteNumber('C-5'), instrument: HAT, volume: vol(12 + r) });
  for (let r = 32; r < 56; r += 2) b.put(r, CH_DRUM, { note: noteNumber('C-5'), instrument: HAT, volume: vol(r % 4 ? 26 : 14) });
  for (const r of [32, 40, 48]) b.put(r, CH_DRUM, { note: noteNumber('C-4'), instrument: KICK, volume: vol(64) });
  // Snare roll with multi retrig: retrigger every 3 ticks, louder each time.
  b.put(56, CH_DRUM, { note: noteNumber('C-4'), instrument: SNARE, volume: vol(16), effect: RETRIG, param: 0x93 });
  b.fxRange(57, 63, CH_DRUM, RETRIG, 0x93);

  // Lead: tone portamento up an octave, vibrato, then key off into the release.
  b.put(44, CH_LEAD, { note: n('E-4'), instrument: LEAD, volume: vol(48) });
  b.put(48, CH_LEAD, { note: n('E-5'), effect: TONE_PORTA, param: 0x10 });
  b.fxRange(49, 51, CH_LEAD, TONE_PORTA, 0x00);
  b.fxRange(52, 59, CH_LEAD, VIBRATO, 0x56);
  b.put(60, CH_LEAD, { note: OFF });
  return b.pattern;
}

/** The main theme over arpeggiated chords. */
function verse(song: Song): Pattern {
  const b = new Builder(song);
  melody(b, CH_LEAD, LEAD, THEME_A);
  arpeggios(b, VERSE, 4);
  bassline(b, VERSE);
  drums(b);
  // Back to full global volume and tempo when the song loops here from the outro.
  b.fx(0, CH_DRUM, GLOBAL_VOL, 0x40);
  b.fx(0, CH_BASS, SPEED, 125);
  return b.pattern;
}

/** The theme again, now gliding between notes, with busier drums. */
function verseSlides(song: Song): Pattern {
  const b = new Builder(song);
  const glide = new Set([6, 22, 38, 56]);
  for (const [row, name, length] of THEME_A) {
    if (glide.has(row)) {
      b.put(row, CH_LEAD, { note: n(name), effect: TONE_PORTA, param: 0x18 });
      b.fxRange(row + 1, row + length - 1, CH_LEAD, TONE_PORTA, 0x00);
    } else {
      b.put(row, CH_LEAD, { note: n(name), instrument: LEAD, volume: vol(56) });
      // Vibrato and volume slide together on the long notes.
      if (length >= 6) b.fxRange(row + 3, row + length - 1, CH_LEAD, VIBRATO_SLIDE, 0x01);
      if (length >= 6) b.fx(row + 2, CH_LEAD, VIBRATO, 0x46);
    }
  }
  arpeggios(b, VERSE, 4, CHORD, true);
  bassline(b, VERSE);
  // The bass glides into each new chord from the volume column.
  for (const bar of [1, 2, 3]) b.put(bar * 16, CH_BASS, { instrument: 0, volume: volPorta(8) });
  drums(b, 'busy');
  return b.pattern;
}

/** Second theme with an echo: the harmony channel repeats the lead three rows later. */
function bridge(song: Song, echo: boolean): Pattern {
  const b = new Builder(song);
  melody(b, CH_LEAD, LEAD, THEME_B, { volume: 60 });
  // Pitch drop at the end of the long G and a tremor stutter on the last note.
  b.fxRange(22, 23, CH_LEAD, PORTA_DOWN, 0x06);
  b.fxRange(58, 63, CH_LEAD, TREMOR, 0x21);
  if (echo) {
    b.put(0, CH_HARM, { effect: PAN, param: 0xd0 });
    b.put(0, CH_LEAD, { effect: PAN, param: 0x40 });
    for (const [row, name] of THEME_B) b.put(row + 3, CH_HARM, { note: n(name), instrument: LEAD, volume: vol(22) });
  } else {
    arpeggios(b, BRIDGE, 4);
    b.put(0, CH_HARM, { volume: vol(48) });
    // The arpeggio drifts from left to right and back (volume column pan slide).
    for (let r = 1; r < 32; r++) if (r % 4) b.put(r, CH_HARM, { volume: panRight(2) });
    for (let r = 33; r < 64; r++) if (r % 4) b.put(r, CH_HARM, { volume: panLeft(2) });
  }
  BRIDGE.forEach((chord, bar) => {
    for (let r = 0; r < 16; r += 2) {
      const note = n(chord.root + (r % 4 === 0 ? 2 : 3));
      b.put(bar * 16 + r, CH_BASS, { note, instrument: BASS, volume: vol(r % 4 === 0 ? 64 : 40) });
    }
  });
  // Walk up from E to A for the return of the first theme.
  ['E-2', 'F#2', 'G#2', 'G#3'].forEach((note, i) => b.put(56 + i * 2, CH_BASS, { note: n(note), instrument: BASS }));
  drums(b, echo ? 'four' : 'busy');
  return b.pattern;
}

/** A break that shows off the rest of the effect column. */
function breakdown(song: Song): Pattern {
  const b = new Builder(song);
  // Rows 0-7 play twice (pattern loop): kick and hat with a staccato bass (note cut).
  for (let r = 0; r < 8; r += 2) b.put(r, CH_DRUM, { note: noteNumber('C-5'), instrument: HAT, volume: vol(32) });
  b.put(0, CH_DRUM, { note: noteNumber('C-4'), instrument: KICK, volume: vol(64), effect: EXTENDED, param: 0x60 });
  b.put(4, CH_DRUM, { note: noteNumber('C-4'), instrument: KICK, volume: vol(48) });
  b.fx(7, CH_DRUM, EXTENDED, 0x61);
  for (let r = 0; r < 8; r += 2) b.put(r, CH_BASS, { note: n(r % 4 ? 'A-3' : 'A-2'), instrument: BASS, effect: EXTENDED, param: 0xc2 });

  // Rows 8-15: a held chord with tremolo.
  b.put(8, CH_HARM, { note: n('A-4'), instrument: CHORD, volume: vol(48), effect: TREMOLO, param: 0x8c });
  b.fxRange(9, 15, CH_HARM, TREMOLO, 0x00);
  for (let r = 8; r < 16; r += 2) b.put(r, CH_BASS, { note: n('A-2'), instrument: BASS, effect: EXTENDED, param: 0xc3 });
  for (let r = 8; r < 16; r += 2) b.put(r, CH_DRUM, { note: noteNumber('C-5'), instrument: HAT, volume: vol(r % 4 ? 26 : 14) });
  b.put(12, CH_DRUM, { note: noteNumber('C-4'), instrument: SNARE, volume: vol(56) });

  // Rows 16-31: lead with tremor, then a fine volume fade; chord arpeggio sweeping right with a pan slide.
  b.put(16, CH_LEAD, { note: n('E-5'), instrument: LEAD, volume: vol(60), effect: TREMOR, param: 0x31 });
  b.fxRange(17, 23, CH_LEAD, TREMOR, 0x31);
  b.put(24, CH_LEAD, { note: n('G-5'), instrument: LEAD, volume: vol(60) });
  b.fxRange(25, 31, CH_LEAD, EXTENDED, 0xb6);
  b.put(16, CH_HARM, { note: n('F-4'), instrument: CHORD, volume: vol(48), effect: ARP, param: 0x47 });
  b.fxRange(17, 23, CH_HARM, PAN_SLIDE, 0x40);
  b.put(24, CH_HARM, { note: n('G-4'), instrument: CHORD, volume: vol(48), effect: PAN_SLIDE, param: 0x08 });
  b.fxRange(25, 31, CH_HARM, PAN_SLIDE, 0x08);
  ['F-2', 'F-3', 'F-2', 'F-3', 'G-2', 'G-3', 'G-2', 'G-3'].forEach((note, i) => b.put(16 + i * 2, CH_BASS, { note: n(note), instrument: BASS, volume: vol(48) }));
  for (let r = 16; r < 32; r += 2) b.put(r, CH_DRUM, { note: noteNumber('C-5'), instrument: HAT, volume: vol(r % 4 ? 26 : 14) });
  for (const r of [16, 24, 26]) b.put(r, CH_DRUM, { note: noteNumber('C-4'), instrument: KICK, volume: vol(64) });
  for (const r of [20, 28]) b.put(r, CH_DRUM, { note: noteNumber('C-4'), instrument: SNARE, volume: vol(64) });

  // Rows 32-47: lead trill as an octave arpeggio, then a dive; bass keyed off early for short notes.
  b.put(32, CH_LEAD, { note: n('A-5'), instrument: LEAD, volume: vol(50), effect: ARP, param: 0xc7 });
  b.fxRange(33, 39, CH_LEAD, ARP, 0xc7);
  b.put(40, CH_LEAD, { note: n('E-5'), instrument: LEAD, volume: vol(56) });
  b.fxRange(44, 47, CH_LEAD, PORTA_DOWN, 0x0c);
  for (let r = 32; r < 48; r += 4) {
    b.put(r, CH_BASS, { note: n(r % 8 ? 'C-3' : 'A-2'), instrument: BASS, volume: vol(64) });
    b.fx(r + 1, CH_BASS, KEY_OFF, 0x02);
  }
  // Hats swing with note delays, the kick plays from a sample offset for a tighter attack.
  for (let r = 32; r < 48; r += 2) b.put(r + 1, CH_DRUM, { note: noteNumber('C-5'), instrument: HAT, volume: vol(30), effect: EXTENDED, param: 0xd2 });
  for (const r of [32, 38, 40, 46]) b.put(r, CH_DRUM, { note: noteNumber('C-4'), instrument: KICK, volume: vol(64), ...(r % 8 ? { effect: OFFSET, param: 0x04 } : {}) });
  for (const r of [36, 44]) b.put(r, CH_DRUM, { note: noteNumber('C-4'), instrument: SNARE, volume: vol(60) });

  // Rows 48-63: faster speed, rising bass and a snare roll that gets louder; speed back at the end.
  b.fx(48, CH_HARM, SPEED, 0x05);
  b.fx(63, CH_HARM, SPEED, 0x06);
  b.put(48, CH_BASS, { note: n('A-2'), instrument: TRI, volume: vol(64), effect: PORTA_UP, param: 0x03 });
  b.fxRange(49, 62, CH_BASS, PORTA_UP, 0x03);
  for (let r = 48; r < 64; r++) {
    const every = r < 56 ? 2 : 1;
    if ((r - 48) % every === 0) b.put(r, CH_DRUM, { note: noteNumber('C-4'), instrument: SNARE, volume: vol(16 + (r - 48) * 3) });
  }
  b.put(48, CH_LEAD, { note: n('E-5'), instrument: LEAD, volume: vol(40), effect: VOL_SLIDE, param: 0x20 });
  b.fxRange(49, 59, CH_LEAD, VOL_SLIDE, 0x10);
  b.put(60, CH_LEAD, { note: OFF });
  return b.pattern;
}

/** Big finish: the lead trills in octaves while the triangle doubles the theme an octave lower. */
function finale(song: Song): Pattern {
  const b = new Builder(song);
  melody(b, CH_LEAD, LEAD, THEME_A, { volume: 52, arp: 0x0c });
  melody(b, CH_HARM, TRI, THEME_A, { transpose: -12, volume: 64 });
  bassline(b, VERSE);
  drums(b, 'busy');
  return b.pattern;
}

/** Pad chords and a fading theme while the global volume slides to silence. */
function outro(song: Song): Pattern {
  const b = new Builder(song);
  ['A-3', 'F-3', 'C-4', 'G-3'].forEach((root, bar) => b.put(bar * 16, CH_HARM, { note: n(root), instrument: PAD, volume: vol(64) }));
  ['A-2', 'F-2', 'C-3', 'G-2'].forEach((root, bar) => b.put(bar * 16, CH_BASS, { note: n(root), instrument: TRI, volume: vol(56) }));
  melody(b, CH_LEAD, LEAD, THEME_A.slice(0, 10), { volume: 44 });
  for (let r = 0; r < 32; r += 8) b.put(r, CH_DRUM, { note: noteNumber('C-4'), instrument: KICK, volume: vol(64 - r) });
  for (let r = 32; r < 64; r += 4) b.put(r, CH_DRUM, { note: noteNumber('C-5'), instrument: HAT, volume: vol(24) });
  // Slow down a little, then fade everything out.
  b.fx(32, CH_BASS, SPEED, 110);
  b.fx(48, CH_BASS, SPEED, 96);
  b.fxRange(32, 63, CH_LEAD, GLOBAL_SLIDE, 0x01);
  b.put(40, CH_LEAD, { note: n('A-4'), instrument: LEAD, volume: vol(40) });
  b.fxRange(43, 47, CH_LEAD, VIBRATO, 0x34);
  b.put(48, CH_LEAD, { note: OFF });
  b.put(63, CH_HARM, { note: OFF, volume: volSlideDown(0) });
  return b.pattern;
}

export function createDemoSong(): Song {
  const song: Song = {
    format: 'xm',
    formatName: 'XM 1.04 (webtracker)',
    title: DEMO_SONG_TITLE,
    channels: CHANNELS,
    orders: [],
    restartPosition: 1,
    patterns: [],
    instruments: instruments(),
    linearFrequency: true,
    initialSpeed: 6,
    initialTempo: 125,
    channelPanning: [104, 152, 128, 128],
  };
  song.patterns = [intro(song), verse(song), verseSlides(song), bridge(song, true), bridge(song, false), breakdown(song), finale(song), outro(song)];
  song.orders = [0, 1, 2, 3, 4, 5, 1, 6, 7];
  return song;
}
