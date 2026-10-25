/**
 * Module replayer. XM songs follow FastTracker 2's replayer closely, quirks
 * included (see the FastTracker 2 section). MOD files, and songs imported
 * from S3M or IT (`song.compat`), use a simpler shared path with Amiga
 * periods and the ProTracker differences switched on via `song.format`.
 *
 * The player has no Web Audio dependency so it runs both inside the
 * AudioWorklet and in Node (tests, offline rendering).
 */
import {
  CELL_SIZE,
  LoopType,
  NOTE_KEY_OFF,
  type Envelope,
  type Instrument,
  type Sample,
  type Song,
} from './song.ts';

// Vibrato/tremolo waveforms, 64 steps, amplitude +-255.
const WAVEFORMS: Int16Array[] = (() => {
  const sine = new Int16Array(64);
  const rampDown = new Int16Array(64);
  const square = new Int16Array(64);
  for (let i = 0; i < 64; i++) {
    sine[i] = Math.round(255 * Math.sin((2 * Math.PI * i) / 64));
    rampDown[i] = 255 - i * 8;
    square[i] = i < 32 ? 255 : -255;
  }
  return [sine, rampDown, square, sine];
})();
const [SINE, RAMP_DOWN, SQUARE] = WAVEFORMS as [Int16Array, Int16Array, Int16Array, Int16Array];

// Instrument auto-vibrato uses a different waveform order: sine, square, ramp down, ramp up.
const AUTO_VIBRATO_WAVEFORMS: Int16Array[] = [SINE, SQUARE, RAMP_DOWN, RAMP_DOWN.map((v) => -v)];

// FastTracker 2 tables: the half sine of vibrato and tremolo (32 steps), and
// the 256 step sine of instrument auto-vibrato, which starts downwards.
const FT2_VIB_TAB = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
];
const FT2_AUTO_VIB_SINE = Int8Array.from({ length: 256 }, (_, i) => Math.round(-64 * Math.sin((2 * Math.PI * i) / 256)));

/** Periods of FT2's note table: 120 notes in 16 finetune steps each, plus 16 entries below. */
const FT2_NOTES = 12 * 10 * 16 + 16;
function ft2PeriodTable(linear: boolean): Float64Array {
  const t = new Float64Array(FT2_NOTES);
  // Index 784 is C-4 at finetune 0. Amiga periods are FT2's divided by four.
  for (let i = 0; i < FT2_NOTES; i++) t[i] = linear ? 7744 - 4 * i : Math.round(1712 * Math.pow(2, -(i - 784) / 192)) / 4;
  return t;
}

/** Where an FT2 envelope is: tick counter, point index, 8.8 value and per tick delta. */
class EnvState {
  tick = 0;
  pos = 0;
  value = 0;
  delta = 0;
}

/**
 * How sample frames are turned into output frames. 'amiga' holds each frame
 * (no interpolation) and runs the mix through the Amiga 500 output filters:
 * the fixed RC low-pass, and the "LED" filter that E00/E01 switch in MOD.
 * 'sinc' is an 8-tap windowed sinc, the cleanest and the most work.
 * 'auto' is 'amiga' for MOD and 'linear' for XM.
 */
export type Resampler = 'auto' | 'sinc' | 'cubic' | 'linear' | 'none' | 'amiga';

// Windowed-sinc kernel: 8 taps around the read position, for SINC_PHASES
// fractional positions. Each phase is normalised so a constant passes unchanged.
const SINC_TAPS = 8;
const SINC_PHASES = 512;
const SINC_TABLE = (() => {
  const table = new Float32Array((SINC_PHASES + 1) * SINC_TAPS);
  const cutoff = 0.97;
  for (let p = 0; p <= SINC_PHASES; p++) {
    const frac = p / SINC_PHASES;
    let sum = 0;
    for (let t = 0; t < SINC_TAPS; t++) {
      // Tap t reads frame idx - 3 + t, at distance x from the read position.
      const x = t - 3 - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      // Blackman window over the kernel's width.
      const w = (x + SINC_TAPS / 2) / SINC_TAPS;
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
      const v = sinc * Math.max(0, window);
      table[p * SINC_TAPS + t] = v;
      sum += v;
    }
    for (let t = 0; t < SINC_TAPS; t++) table[p * SINC_TAPS + t]! /= sum;
  }
  return table;
})();

// A500 output stage: one-pole RC low-pass near 4.4 kHz, LED filter a
// two-pole Butterworth-like low-pass near 3.3 kHz.
const A500_RC_HZ = 4420;
const LED_HZ = 3275;
const LED_Q = 0.66;

/** Length of the volume ramp applied to every gain change, in seconds. */
const RAMP_SECONDS = 0.003;

export interface PlayerState {
  order: number;
  pattern: number;
  row: number;
  speed: number;
  tempo: number;
  playing: boolean;
  /** Number of times the song wrapped around. */
  loops: number;
}

/** What one sounding voice is doing, for play markers in the editors. */
export interface VoiceState {
  /** Song channel, or -1 for the preview voice. */
  channel: number;
  /** 1-based instrument and 0-based sample within it. */
  instrument: number;
  sample: number;
  note: number;
  /** Playback position in sample frames. */
  pos: number;
  /** Current envelope positions in ticks. */
  volEnvTick: number;
  panEnvTick: number;
}

// Envelopes are only evaluated when enabled, which the loaders only allow with at least one point.
function envelopeValue(env: Envelope, tick: number): number {
  const pts = env.points;
  if (tick <= pts[0]!.x) return pts[0]!.y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (tick < b.x) {
      if (b.x === a.x) return b.y;
      return a.y + ((b.y - a.y) * (tick - a.x)) / (b.x - a.x);
    }
  }
  return pts[pts.length - 1]!.y;
}

/** The tick an FT2 envelope shows: its counter runs on while it holds at sustain or the end. */
function envelopeTick(env: Envelope, st: EnvState): number {
  const pt = env.points[Math.min(st.pos, env.points.length - 1)];
  return Math.max(0, pt ? Math.min(st.tick, pt.x) : st.tick);
}

function envelopeAdvance(env: Envelope, tick: number, keyOn: boolean): number {
  const pts = env.points;
  if (env.sustain && keyOn && tick === pts[env.sustainPoint]!.x) return tick;
  tick++;
  if (env.loop && tick === pts[env.loopEnd]!.x && !(env.sustain && keyOn && env.loopEnd === env.sustainPoint)) {
    tick = pts[env.loopStart]!.x;
  }
  return Math.min(tick, 0xffff);
}

class Channel {
  instrument: Instrument | null = null;
  sample: Sample | null = null;
  instrumentNumber = 0;
  note = 0;

  // Sample playback.
  active = false;
  pos = 0;
  dir = 1;
  // Band-limited step state for the Amiga resampler: the frame held last and
  // the correction owed to the next output frame.
  held = 0;
  blepNext = 0;
  step = 0;

  // Pitch.
  period = 0;
  outPeriod = 0;
  targetPeriod = 0;
  finetune = 0;
  relativeNote = 0;

  // Volume and panning (0..64, 0..255).
  volume = 0;
  outVolume = 0;
  panning = 128;
  /** IT-style channel volume, 0..64, on top of the note volume. */
  channelVolume = 64;
  channelVolSlideMem = 0;
  outPanning = 128;

  // Instrument envelopes.
  keyOn = false;
  fadeout = 32768;
  volEnvTick = 0;
  panEnvTick = 0;
  autoVibPos = 0;
  autoVibSweep = 0;

  // Effect state and memory.
  portaUpMem = 0;
  portaDownMem = 0;
  tonePortaSpeed = 0;
  fineUpMem = 0;
  fineDownMem = 0;
  extraFineUpMem = 0;
  extraFineDownMem = 0;
  volSlideMem = 0;
  fineVolUpMem = 0;
  fineVolDownMem = 0;
  panSlideMem = 0;
  globalVolSlideMem = 0;
  offsetMem = 0;
  retrigMem = 0;
  multiRetrigMem = 0;
  tremorMem = 0;
  vibratoSpeed = 0;
  vibratoDepth = 0;
  vibratoPos = 0;
  vibratoWave = 0;
  tremoloSpeed = 0;
  tremoloDepth = 0;
  tremoloPos = 0;
  tremoloWave = 0;
  tremorPos = 0;
  tremorOn = true;
  loopRow = 0;
  loopCount = 0;
  /** FT2 tone portamento direction: 0 none, 1 towards higher period, 2 towards lower. */
  portaDirection = 0;
  /** Vibrato/tremolo offsets computed by this tick's effects. */
  vibratoOffset = 0;
  tremoloOffset = 0;

  // FastTracker 2 state. In XM songs `period`/`volume` are FT2's real period and
  // volume, while `outPeriod`/`outVolume` keep what vibrato, arpeggio, tremolo
  // and tremor last made of them, until the next command resets them.
  oldVolume = 0;
  oldPanning = 128;
  glissando = false;
  retrigCount = 0;
  retrigSpeed = 0;
  retrigVolume = 0;
  volEnv = new EnvState();
  panEnv = new EnvState();
  autoVibAmp = 0;
  /** Off for a released preview note that should ring out instead of fading. */
  fading = true;
  /** Note and instrument of the current row, for note delay. */
  rowNote = 0;
  rowInstrument = 0;

  // Current row.
  effect = 0;
  param = 0;
  volCmd = 0;
  delayedCell: Uint8Array | null = null;

  // Mixer gains with linear ramping.
  gainL = 0;
  gainR = 0;
  targetL = 0;
  targetR = 0;
  rampL = 0;
  rampR = 0;
  rampLeft = 0;

  constructor(panning: number) {
    this.panning = panning;
  }
}

export class Player {
  readonly song: Song;
  readonly sampleRate: number;
  private channels: Channel[] = [];
  /** Extra voice for notes played on the keyboard outside the song. */
  private preview = new Channel(128);
  private isMod: boolean;

  playing = false;
  order = 0;
  row = 0;
  tick = 0;
  speed = 6;
  tempo = 125;
  globalVolume = 64;
  loops = 0;
  /** Repeat the current pattern instead of advancing through the order list. */
  loopPattern = false;
  /** Channels that keep playing but are not heard, by channel index. */
  muted: boolean[] = [];
  /** See Resampler; 'none' gives the raw, aliased chip sound. */
  resampler: Resampler = 'auto';
  /** Stereo width in percent: 0 is mono, 100 the song's panning, 200 twice as wide. */
  stereoSeparation = 100;
  /** Short volume ramps against clicks; off changes volume at once, like old hardware. */
  volumeRamps = true;
  /** Overall output gain applied after mixing. */
  masterGain: number;

  private samplesLeftInTick = 0;
  private patternDelay = 0;
  private repeatingRow = false;
  private jumpOrder = -1;
  private breakRow = -1;
  private loopJumpRow = -1;
  /** FastTracker 2 semantics, for XM songs that were not imported from S3M or IT. */
  private ft2: boolean;
  private ft2Periods: Float64Array;
  // FT2 sequencing: break row, jump flags and the two pattern delay counters.
  private breakPos = 0;
  private breakFlag = false;
  private posJumpFlag = false;
  private pattDelTime = 0;
  private pattDelTime2 = 0;
  private rampSamples: number;
  /** ProTracker E0x: the LED filter, on with E00, off with E01. */
  ledFilter = false;
  private rcCoef: number;
  private filterState = new Float64Array(10);
  private led: { b0: number; b1: number; b2: number; a1: number; a2: number };
  // Per channel output for scopes: a ring buffer each, filled from a block tap.
  private scopeRings: Float32Array[] = [];
  private scopeTaps: Float32Array[] = [];
  private scopePos = 0;

  /** Called whenever a new row starts playing. */
  onRow: ((state: PlayerState) => void) | null = null;

  constructor(song: Song, sampleRate: number) {
    this.song = song;
    this.sampleRate = sampleRate;
    this.isMod = song.format === 'mod';
    this.ft2 = !this.isMod && !song.compat;
    this.ft2Periods = ft2PeriodTable(song.linearFrequency);
    this.rampSamples = Math.max(1, Math.round(sampleRate * RAMP_SECONDS));
    // Four full-volume channels in phase stay just under full scale.
    this.masterGain = 0.8 / Math.sqrt(Math.max(4, song.channels));
    this.rcCoef = 1 - Math.exp((-2 * Math.PI * A500_RC_HZ) / sampleRate);
    this.led = biquadLowPass(LED_HZ, LED_Q, sampleRate);
    this.reset();
  }

  /** Starts over at `order`, optionally at `row` of that position's pattern. */
  reset(order = 0, row = 0): void {
    const song = this.song;
    this.channels = song.channelPanning.map((p, i) => {
      const ch = new Channel(p);
      ch.channelVolume = Math.min(64, song.channelVolume?.[i] ?? 64);
      return ch;
    });
    if (this.scopeRings.length) this.enableScopes(this.scopeRings[0]!.length);
    this.order = Math.min(order, song.orders.length - 1);
    const rows = song.patterns[song.orders[this.order] ?? 0]?.rows ?? 64;
    this.row = Math.max(0, Math.min(row, rows - 1));
    this.tick = 0;
    this.speed = song.initialSpeed;
    this.tempo = song.initialTempo;
    this.globalVolume = Math.min(64, song.initialGlobalVolume ?? 64);
    this.samplesLeftInTick = 0;
    this.patternDelay = 0;
    this.repeatingRow = false;
    this.jumpOrder = -1;
    this.breakRow = -1;
    this.loopJumpRow = -1;
    this.breakPos = 0;
    this.breakFlag = false;
    this.posJumpFlag = false;
    this.pattDelTime = 0;
    this.pattDelTime2 = 0;
    this.loops = 0;
    this.ledFilter = false;
    this.filterState.fill(0);
  }

  /** The resampler in effect, with 'auto' resolved by the song's format. */
  get activeResampler(): Exclude<Resampler, 'auto'> {
    if (this.resampler !== 'auto') return this.resampler;
    return this.isMod ? 'amiga' : 'linear';
  }

  getState(): PlayerState {
    return {
      order: this.order,
      pattern: this.song.orders[this.order] ?? 0,
      row: this.row,
      speed: this.speed,
      tempo: this.tempo,
      playing: this.playing,
      loops: this.loops,
    };
  }

  /** Renders `frames` stereo frames into the given buffers (overwriting them). */
  process(left: Float32Array, right: Float32Array, frames = left.length): void {
    left.fill(0, 0, frames);
    right.fill(0, 0, frames);
    if (!this.playing && !this.preview.active) return;
    const taps = this.scopeTaps;
    if (taps.length) {
      if ((taps[0]?.length ?? 0) < frames) {
        this.scopeTaps = this.channels.map(() => new Float32Array(frames));
      } else {
        for (const tap of taps) tap.fill(0, 0, frames);
      }
    }

    let offset = 0;
    while (offset < frames) {
      if (this.samplesLeftInTick <= 0) {
        // Stopped, only the preview voice runs its envelopes on the tick clock.
        if (this.playing) this.doTick();
        else this.updateChannel(this.preview);
        this.samplesLeftInTick += (this.sampleRate * 2.5) / this.tempo;
      }
      const n = Math.min(frames - offset, Math.ceil(this.samplesLeftInTick));
      if (this.playing) {
        this.channels.forEach((ch, c) => this.mixChannel(ch, left, right, offset, n, this.scopeTaps[c], this.muted[c] === true));
      }
      // The preview voice is heard but stays out of the scopes.
      this.mixChannel(this.preview, left, right, offset, n);
      this.samplesLeftInTick -= n;
      offset += n;
    }
    if (this.playing && this.scopeTaps.length) this.pushScopes(frames);

    if (this.activeResampler === 'amiga') this.amigaFilter(left, right, frames);
    const g = this.masterGain;
    const width = Math.max(0, this.stereoSeparation) / 100;
    for (let i = 0; i < frames; i++) {
      let l = left[i]!;
      let r = right[i]!;
      if (width !== 1) {
        const mid = (l + r) / 2;
        const side = ((l - r) / 2) * width;
        l = mid + side;
        r = mid - side;
      }
      left[i] = softClip(l * g);
      right[i] = softClip(r * g);
    }
  }

  private amigaFilter(left: Float32Array, right: Float32Array, frames: number): void {
    const st = this.filterState;
    const k = this.rcCoef;
    const { b0, b1, b2, a1, a2 } = this.led;
    const led = this.ledFilter;
    const run = (buf: Float32Array, o: number) => {
      let rc = st[o]!, x1 = st[o + 1]!, x2 = st[o + 2]!, y1 = st[o + 3]!, y2 = st[o + 4]!;
      for (let i = 0; i < frames; i++) {
        rc += (buf[i]! - rc) * k;
        let v = rc;
        if (led) {
          const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = v;
          y2 = y1;
          y1 = y;
          v = y;
        } else {
          // Keep the LED stage primed so switching it on does not click.
          x2 = x1;
          x1 = y2 = y1 = v;
        }
        buf[i] = v;
      }
      st[o] = rc; st[o + 1] = x1; st[o + 2] = x2; st[o + 3] = y1; st[o + 4] = y2;
    };
    run(left, 0);
    run(right, 5);
  }

  // ---------------------------------------------------------------- sequencing

  private doTick(): void {
    if (this.ft2) {
      this.ft2DoTick();
      return;
    }
    if (this.tick === 0) {
      if (this.repeatingRow) {
        for (const ch of this.channels) this.tickEffects(ch);
      } else {
        this.processRow();
      }
    } else {
      for (const ch of this.channels) this.tickEffects(ch);
    }

    for (const ch of this.channels) this.updateChannel(ch);
    this.updateChannel(this.preview);

    this.tick++;
    if (this.tick >= this.speed) {
      this.tick = 0;
      if (this.patternDelay > 0) {
        this.patternDelay--;
        this.repeatingRow = true;
      } else {
        this.repeatingRow = false;
        this.nextRow();
      }
    }
  }

  private nextRow(): void {
    const song = this.song;
    if (this.loopJumpRow >= 0) {
      this.row = this.loopJumpRow;
      this.loopJumpRow = -1;
      this.jumpOrder = -1;
      this.breakRow = -1;
    } else if (this.jumpOrder >= 0 || this.breakRow >= 0) {
      const target = this.loopPattern ? this.order : this.jumpOrder >= 0 ? this.jumpOrder : this.order + 1;
      if (target <= this.order && this.jumpOrder >= 0) this.loops++;
      this.order = target;
      this.row = this.breakRow >= 0 ? this.breakRow : 0;
      this.jumpOrder = -1;
      this.breakRow = -1;
      if (this.order >= song.orders.length) {
        this.order = song.restartPosition;
        this.loops++;
      }
      const pattern = song.patterns[song.orders[this.order] ?? 0];
      if (pattern && this.row >= pattern.rows) this.row = 0;
      return;
    } else {
      this.row++;
    }

    const pattern = song.patterns[song.orders[this.order] ?? 0];
    if (!pattern || this.row >= pattern.rows) {
      this.row = 0;
      if (this.loopPattern) return;
      this.order++;
      for (const ch of this.channels) ch.loopRow = 0;
      if (this.order >= song.orders.length) {
        this.order = song.restartPosition;
        this.loops++;
      }
    }
  }

  private processRow(): void {
    const song = this.song;
    const pattern = song.patterns[song.orders[this.order] ?? 0];
    this.onRow?.(this.getState());
    if (!pattern) return;
    const base = this.row * song.channels * CELL_SIZE;
    for (let c = 0; c < song.channels; c++) {
      const cell = pattern.data.subarray(base + c * CELL_SIZE, base + (c + 1) * CELL_SIZE);
      if (this.ft2) this.ft2Row(this.channels[c]!, cell);
      else this.processCell(this.channels[c]!, cell);
    }
  }

  // ------------------------------------------------------------------- pitch

  private periodForNote(note: number, finetune: number): number {
    // note is 0-based including the sample's relative note; 48 = C-4.
    if (this.song.linearFrequency) return 7680 - note * 64 - finetune / 2;
    return 428 * Math.pow(2, -(note - 48 + finetune / 128) / 12);
  }

  private frequency(period: number): number {
    if (period <= 0) return 0;
    if (this.song.linearFrequency) return 8363 * Math.pow(2, (4608 - period) / 768);
    return (8363 * 428) / period;
  }

  /** Converts a slide amount given in effect units into period units. */
  private slideUnits(amount: number): number {
    return this.song.linearFrequency ? amount * 4 : amount;
  }

  private clampPeriod(period: number): number {
    if (this.isMod) return Math.max(113, Math.min(856 * 2, period));
    if (this.song.linearFrequency) return Math.max(1, Math.min(7680, period));
    return Math.max(1, Math.min(32000, period));
  }

  // ------------------------------------------------------------------- notes

  private triggerNote(ch: Channel, note: number, finetuneOverride: number | null): void {
    const ins = ch.instrument;
    if (!ins) {
      ch.active = false;
      return;
    }
    const sample = ins.samples[ins.keymap[note - 1] ?? 0] ?? ins.samples[0];
    if (!sample || sample.data.length === 0) {
      ch.active = false;
      return;
    }
    const real = note - 1 + sample.relativeNote;
    if (real < 0 || real > 118) return;

    ch.sample = sample;
    ch.note = note;
    ch.relativeNote = sample.relativeNote;
    ch.finetune = finetuneOverride ?? sample.finetune;
    ch.period = this.periodForNote(real, ch.finetune);
    ch.pos = 0;
    ch.dir = 1;
    ch.active = true;
    if (ch.vibratoWave < 4) ch.vibratoPos = 0;
    if (ch.tremoloWave < 4) ch.tremoloPos = 0;
    ch.tremorPos = 0;
    // Start from silence so a retriggered sample does not click.
    ch.gainL = ch.gainR = 0;
    ch.targetL = ch.targetR = -1; // forces a new ramp in updateChannel
    ch.rampLeft = 0;
  }

  private resetInstrumentState(ch: Channel, ins: Instrument): void {
    // FT2 takes the defaults from the sample that is playing (which tone portamento
    // does not change); ProTracker takes them from the new instrument.
    const sample = this.isMod ? ins.samples[0] : ch.sample;
    if (sample) {
      ch.volume = sample.volume;
      if (!this.isMod && sample.usePanning !== false) ch.panning = sample.panning;
    }
    ch.keyOn = true;
    ch.fadeout = 32768;
    ch.volEnvTick = 0;
    ch.panEnvTick = 0;
    ch.autoVibPos = 0;
    ch.autoVibSweep = 0;
  }

  private keyOff(ch: Channel): void {
    ch.keyOn = false;
    if (!ch.instrument || !ch.instrument.volumeEnvelope.enabled) ch.volume = 0;
  }

  private processCell(ch: Channel, cell: Uint8Array): void {
    const [note = 0, ins = 0, vol = 0, effect = 0, param = 0] = cell;
    ch.effect = effect;
    ch.param = param;
    ch.volCmd = vol;

    // Note delay: the whole cell is evaluated on a later tick.
    if (effect === 0x0e && param >> 4 === 0x0d && (param & 0x0f) > 0) {
      ch.delayedCell = cell;
      return;
    }
    ch.delayedCell = null;
    this.applyCell(ch, note, ins, vol, effect, param);
    this.volumeColumnTick0(ch, vol);
    this.effectTick0(ch, effect, param, note);
  }

  private applyCell(ch: Channel, note: number, ins: number, vol: number, effect: number, param: number, delayed = false): void {
    // A delayed note is always triggered, even with a tone portamento in the volume column.
    const tonePorta = !delayed && (effect === 0x03 || effect === 0x05 || vol >> 4 === 0x0f);

    if (ins > 0) {
      ch.instrumentNumber = ins;
      ch.instrument = this.song.instruments[ins - 1] ?? null;
      if (!ch.instrument && !tonePorta) ch.active = false;
    }

    if (note === NOTE_KEY_OFF) {
      this.keyOff(ch);
      return;
    }

    if (note > 0) {
      if (tonePorta && ch.active && ch.sample) {
        const real = note - 1 + ch.relativeNote;
        ch.targetPeriod = this.periodForNote(real, ch.finetune);
        ch.portaDirection = ch.targetPeriod === ch.period ? 0 : ch.targetPeriod > ch.period ? 1 : 2;
      } else {
        const finetune = effect === 0x0e && param >> 4 === 0x05 ? ((param & 0x0f) - 8) * 16 : null;
        this.triggerNote(ch, note, finetune);
      }
    }

    if (ins > 0 && ch.instrument) this.resetInstrumentState(ch, ch.instrument);
  }

  // ----------------------------------------------------------------- effects

  private volumeColumnTick0(ch: Channel, vol: number): void {
    const cmd = vol >> 4;
    const x = vol & 0x0f;
    switch (cmd) {
      case 0x1: case 0x2: case 0x3: case 0x4:
        ch.volume = vol - 0x10;
        break;
      case 0x5:
        ch.volume = Math.min(64, vol - 0x10);
        break;
      case 0x8:
        ch.volume = Math.max(0, ch.volume - x);
        break;
      case 0x9:
        ch.volume = Math.min(64, ch.volume + x);
        break;
      case 0xa:
        if (x) ch.vibratoSpeed = x;
        break;
      case 0xb:
        if (x) ch.vibratoDepth = x;
        break;
      case 0xc:
        ch.panning = x << 4;
        break;
      case 0xf:
        if (x) ch.tonePortaSpeed = x << 4;
        break;
    }
  }

  private volumeColumnTick(ch: Channel): void {
    const vol = ch.volCmd;
    const cmd = vol >> 4;
    const x = vol & 0x0f;
    switch (cmd) {
      case 0x6:
        ch.volume = Math.max(0, ch.volume - x);
        break;
      case 0x7:
        ch.volume = Math.min(64, ch.volume + x);
        break;
      case 0xb:
        this.vibrato(ch);
        break;
      case 0xd:
        ch.panning = Math.max(0, ch.panning - x);
        break;
      case 0xe:
        ch.panning = Math.min(255, ch.panning + x);
        break;
      case 0xf:
        this.tonePorta(ch);
        break;
    }
  }

  private effectTick0(ch: Channel, effect: number, param: number, note: number): void {
    const x = param >> 4;
    const y = param & 0x0f;
    switch (effect) {
      case 0x01:
        if (param) ch.portaUpMem = param;
        break;
      case 0x02:
        if (param) ch.portaDownMem = param;
        break;
      case 0x03:
        if (param) ch.tonePortaSpeed = param;
        break;
      case 0x04:
        if (x) ch.vibratoSpeed = x;
        if (y) ch.vibratoDepth = y;
        break;
      case 0x05:
      case 0x06:
      case 0x0a:
        if (param) ch.volSlideMem = param;
        break;
      case 0x07:
        if (x) ch.tremoloSpeed = x;
        if (y) ch.tremoloDepth = y;
        break;
      case 0x08:
        ch.panning = param;
        break;
      case 0x09:
        if (param) ch.offsetMem = param;
        if (note > 0 && note !== NOTE_KEY_OFF && ch.sample) {
          ch.pos = ch.offsetMem * 256;
          if (ch.pos >= ch.sample.data.length) {
            if (ch.sample.loopType !== LoopType.None) ch.pos = ch.sample.loopStart;
            else ch.active = false;
          }
        }
        break;
      case 0x0b:
        this.jumpOrder = param;
        break;
      case 0x0c:
        ch.volume = Math.min(64, param);
        break;
      case 0x0d: {
        const row = x * 10 + y;
        this.breakRow = row < 256 ? row : 0;
        break;
      }
      case 0x0e:
        this.extendedTick0(ch, x, y, note);
        break;
      case 0x0f:
        if (param === 0) break;
        if (param < 32) this.speed = param;
        else this.tempo = param;
        break;
      case 0x10: // Gxx
        this.globalVolume = Math.min(64, param);
        break;
      case 0x11: // Hxy
        if (param) ch.globalVolSlideMem = param;
        break;
      case 0x14: // Kxx
        if (param === 0) this.keyOff(ch);
        break;
      case 0x15: // Lxx
        ch.volEnvTick = param;
        // FT2 bug: the panning envelope only follows when the volume envelope has sustain on.
        if (ch.instrument?.volumeEnvelope.sustain) ch.panEnvTick = param;
        break;
      case 0x16: // Mxx: channel volume
        ch.channelVolume = Math.min(64, param);
        break;
      case 0x17: // Nxy: channel volume slide, NxF and NFy fine
        if (param) ch.channelVolSlideMem = param;
        {
          const m = ch.channelVolSlideMem;
          if ((m & 0x0f) === 0x0f && m >> 4) ch.channelVolume = Math.min(64, ch.channelVolume + (m >> 4));
          else if (m >> 4 === 0x0f && m & 0x0f) ch.channelVolume = Math.max(0, ch.channelVolume - (m & 0x0f));
        }
        break;
      case 0x19: // Pxy
        if (param) ch.panSlideMem = param;
        break;
      case 0x1b: // Rxy
        if (param) ch.multiRetrigMem = param;
        break;
      case 0x1d: // Txy
        if (param) ch.tremorMem = param;
        break;
      case 0x21: // X1y / X2y
        if (x === 1) {
          if (y) ch.extraFineUpMem = y;
          ch.period = this.clampPeriod(ch.period - (this.song.linearFrequency ? ch.extraFineUpMem : ch.extraFineUpMem / 4));
        } else if (x === 2) {
          if (y) ch.extraFineDownMem = y;
          ch.period = this.clampPeriod(ch.period + (this.song.linearFrequency ? ch.extraFineDownMem : ch.extraFineDownMem / 4));
        }
        break;
    }
  }

  private extendedTick0(ch: Channel, x: number, y: number, note: number): void {
    switch (x) {
      case 0x0:
        if (this.isMod) this.ledFilter = (y & 1) === 0;
        break;
      case 0x1:
        if (y || this.isMod) ch.fineUpMem = y;
        ch.period = this.clampPeriod(ch.period - this.slideUnits(ch.fineUpMem));
        break;
      case 0x2:
        if (y || this.isMod) ch.fineDownMem = y;
        ch.period = this.clampPeriod(ch.period + this.slideUnits(ch.fineDownMem));
        break;
      case 0x4:
        ch.vibratoWave = y & 7;
        break;
      case 0x5:
        // Handled when the note is triggered.
        break;
      case 0x6:
        if (y === 0) {
          ch.loopRow = this.row;
        } else if (ch.loopCount === 0) {
          ch.loopCount = y;
          this.loopJumpRow = ch.loopRow;
        } else if (--ch.loopCount > 0) {
          this.loopJumpRow = ch.loopRow;
        }
        break;
      case 0x7:
        ch.tremoloWave = y & 7;
        break;
      case 0x8:
        ch.panning = y * 17;
        break;
      case 0x9:
        // E90 retriggers on tick 0 when the row has no note of its own.
        if (y === 0 && note === 0 && !this.isMod) this.retrigger(ch);
        break;
      case 0xa:
        if (y || this.isMod) ch.fineVolUpMem = y;
        ch.volume = Math.min(64, ch.volume + ch.fineVolUpMem);
        break;
      case 0xb:
        if (y || this.isMod) ch.fineVolDownMem = y;
        ch.volume = Math.max(0, ch.volume - ch.fineVolDownMem);
        break;
      case 0xc:
        if (y === 0) ch.volume = 0;
        break;
      case 0xe:
        if (this.patternDelay === 0) this.patternDelay = y;
        break;
    }
  }

  private tickEffects(ch: Channel): void {
    const tick = this.tick;

    if (ch.delayedCell && tick === ((ch.delayedCell[4] ?? 0) & 0x0f)) {
      const [note = 0, ins = 0, vol = 0] = ch.delayedCell;
      ch.delayedCell = null;
      this.applyCell(ch, note, ins, vol, 0, 0, true);
      this.volumeColumnTick0(ch, vol);
      return;
    }

    this.volumeColumnTick(ch);

    const param = ch.param;
    const x = param >> 4;
    const y = param & 0x0f;
    switch (ch.effect) {
      case 0x00:
        // Arpeggio is applied in updateChannel.
        break;
      case 0x01: {
        const amount = this.isMod ? param : ch.portaUpMem;
        ch.period = this.clampPeriod(ch.period - this.slideUnits(amount));
        break;
      }
      case 0x02: {
        const amount = this.isMod ? param : ch.portaDownMem;
        ch.period = this.clampPeriod(ch.period + this.slideUnits(amount));
        break;
      }
      case 0x03:
        this.tonePorta(ch);
        break;
      case 0x04:
        this.vibrato(ch);
        break;
      case 0x05:
        this.tonePorta(ch);
        this.volumeSlide(ch);
        break;
      case 0x06:
        this.vibrato(ch);
        this.volumeSlide(ch);
        break;
      case 0x07:
        this.tremolo(ch);
        break;
      case 0x0a:
        this.volumeSlide(ch);
        break;
      case 0x0e:
        this.extendedTick(ch, x, y);
        break;
      case 0x11: {
        const p = ch.globalVolSlideMem;
        if (p >> 4) this.globalVolume = Math.min(64, this.globalVolume + (p >> 4));
        else this.globalVolume = Math.max(0, this.globalVolume - (p & 0x0f));
        break;
      }
      case 0x14:
        if (tick === param) this.keyOff(ch);
        break;
      case 0x17: {
        const m = ch.channelVolSlideMem;
        if ((m & 0x0f) === 0x0f || m >> 4 === 0x0f) break; // fine slides act on tick 0
        if (m >> 4) ch.channelVolume = Math.min(64, ch.channelVolume + (m >> 4));
        else ch.channelVolume = Math.max(0, ch.channelVolume - (m & 0x0f));
        break;
      }
      case 0x19: {
        const p = ch.panSlideMem;
        if (p >> 4) ch.panning = Math.min(255, ch.panning + (p >> 4));
        else ch.panning = Math.max(0, ch.panning - (p & 0x0f));
        break;
      }
      case 0x1b: {
        const interval = ch.multiRetrigMem & 0x0f;
        if (interval && tick % interval === 0) {
          ch.volume = multiRetrigVolume(ch.volume, ch.multiRetrigMem >> 4);
          this.retrigger(ch);
        }
        break;
      }
      case 0x1d: {
        const on = (ch.tremorMem >> 4) + 1;
        const off = (ch.tremorMem & 0x0f) + 1;
        ch.tremorOn = ch.tremorPos % (on + off) < on;
        ch.tremorPos++;
        break;
      }
    }
  }

  private extendedTick(ch: Channel, x: number, y: number): void {
    switch (x) {
      case 0x9:
        if (y && this.tick % y === 0) this.retrigger(ch);
        break;
      case 0xc:
        if (this.tick === y) ch.volume = 0;
        break;
    }
  }

  private retrigger(ch: Channel): void {
    if (!ch.sample) return;
    ch.pos = 0;
    ch.dir = 1;
    ch.active = true;
    if (!this.isMod) {
      ch.keyOn = true;
      ch.fadeout = 32768;
      ch.volEnvTick = 0;
      ch.panEnvTick = 0;
    }
  }

  private volumeSlide(ch: Channel): void {
    const p = this.isMod ? ch.param : ch.volSlideMem;
    if (p >> 4) ch.volume = Math.min(64, ch.volume + (p >> 4));
    else ch.volume = Math.max(0, ch.volume - (p & 0x0f));
  }

  private tonePorta(ch: Channel): void {
    if (!ch.targetPeriod) return;
    const speed = this.slideUnits(ch.tonePortaSpeed);
    if (this.isMod) {
      // ProTracker forgets the target once it is reached.
      if (ch.period < ch.targetPeriod) ch.period = Math.min(ch.targetPeriod, ch.period + speed);
      else if (ch.period > ch.targetPeriod) ch.period = Math.max(ch.targetPeriod, ch.period - speed);
      if (ch.period === ch.targetPeriod) ch.targetPeriod = 0;
      return;
    }
    // FT2 keeps sliding in the direction chosen when the note was set. After reaching
    // the target the direction becomes "up in period", so a later 300 snaps back
    // from below the note but slides back from above it.
    if (ch.portaDirection === 1) {
      ch.period += speed;
      if (ch.period >= ch.targetPeriod) {
        ch.period = ch.targetPeriod;
        ch.portaDirection = 1;
      }
    } else if (ch.portaDirection === 2) {
      ch.period -= speed;
      if (ch.period <= ch.targetPeriod) {
        ch.period = ch.targetPeriod;
        ch.portaDirection = 1;
      }
    }
  }

  private vibrato(ch: Channel): void {
    const v = WAVEFORMS[ch.vibratoWave & 3]![ch.vibratoPos & 63]! * ch.vibratoDepth;
    // ProTracker: depth/128 periods; FT2 linear: depth/32 units.
    ch.vibratoOffset = this.song.linearFrequency ? v / 32 : v / 128;
    ch.vibratoPos = (ch.vibratoPos + ch.vibratoSpeed) & 63;
  }

  private tremolo(ch: Channel): void {
    ch.tremoloOffset = (WAVEFORMS[ch.tremoloWave & 3]![ch.tremoloPos & 63]! * ch.tremoloDepth) / 64;
    ch.tremoloPos = (ch.tremoloPos + ch.tremoloSpeed) & 63;
  }

  // ------------------------------------------------------- FastTracker 2
  //
  // XM songs follow FT2's replayer closely, quirks included, since that is
  // what XM music was written against: arpeggio counts ticks backwards,
  // vibrato and tremolo results stick until a command resets them, pattern
  // loops leak their row into the next pattern, and so on.

  private ft2DoTick(): void {
    if (this.tick === 0 && this.pattDelTime2 === 0) this.processRow();
    else for (const ch of this.channels) this.ft2Effects(ch);

    for (const ch of this.channels) this.updateChannel(ch);
    this.updateChannel(this.preview);

    this.tick++;
    if (this.tick >= this.speed) {
      this.tick = 0;
      this.ft2NextPos();
    }
  }

  private ft2NextPos(): void {
    const song = this.song;
    this.row++;
    if (this.pattDelTime > 0) {
      this.pattDelTime2 = this.pattDelTime;
      this.pattDelTime = 0;
    }
    if (this.pattDelTime2 > 0 && --this.pattDelTime2 > 0) this.row--;
    if (this.breakFlag) {
      this.breakFlag = false;
      this.row = this.breakPos;
    }
    const rows = song.patterns[song.orders[this.order] ?? 0]?.rows ?? 64;
    if (this.row < rows && !this.posJumpFlag) return;

    // FT2 keeps the break row of a pattern loop, so the next pattern can start there.
    this.row = this.breakPos;
    this.breakPos = 0;
    this.posJumpFlag = false;
    if (!this.loopPattern) {
      const target = this.jumpOrder >= 0 ? this.jumpOrder : this.order + 1;
      if (this.jumpOrder >= 0 && target <= this.order) this.loops++;
      this.order = target;
      if (this.order >= song.orders.length) {
        this.order = song.restartPosition < song.orders.length ? song.restartPosition : 0;
        this.loops++;
      }
    }
    this.jumpOrder = -1;
    const pattern = song.patterns[song.orders[this.order] ?? 0];
    if (pattern && this.row >= pattern.rows) this.row = 0;
  }

  /** Period of a 0-based note (C-0 = 0); FT2 drops the low three bits of the finetune. */
  private ft2Period(note: number, finetune: number): number {
    return this.ft2Periods[Math.max(0, Math.min(FT2_NOTES - 1, note * 16 + (finetune >> 3) + 16))]!;
  }

  /** FT2's relocateTon: the note nearest to `period`, plus `semis` semitones, as a period. */
  private ft2Relocate(period: number, semis: number, ch: Channel): number {
    const table = this.ft2Periods;
    const fine = (ch.finetune >> 3) + 16;
    let hi = 8 * 12 * 16;
    let lo = 0;
    for (let i = 0; i < 8; i++) {
      const tmp = (((lo + hi) >> 1) & ~15) + fine;
      if (period >= table[Math.max(0, tmp - 8)]!) hi = (tmp - fine) & ~15;
      else lo = (tmp - fine) & ~15;
    }
    let tmp = lo + fine + (semis << 4);
    // FT2's search only covers 8 octaves, so arpeggio never goes above B-7.
    if (tmp >= 8 * 12 * 16 + 15 - 1) tmp = 8 * 12 * 16 + 16 - 1;
    return table[tmp]!;
  }

  private ft2Frequency(period: number): number {
    if (period <= 0) return 0;
    if (!this.song.linearFrequency) return (8363 * 428) / period;
    // FT2 computes in 16 bits, so periods past the bottom of the range wrap around.
    const inv = (9216 - Math.round(period)) & 0xffff;
    const shift = (14 - Math.floor(inv / 768)) & 31;
    return 8363 * Math.pow(2, 8 - shift + (inv % 768) / 768);
  }

  /** The highest period slides may reach, 31999 in FT2's units. */
  private get ft2MaxPeriod(): number {
    return this.song.linearFrequency ? 31999 : 31999 / 4;
  }

  private ft2Row(ch: Channel, cell: Uint8Array): void {
    const [note = 0, instrument = 0, vol = 0, effect = 0, param = 0] = cell;
    ch.volCmd = vol;
    // Arpeggio or vibrato that stops here puts the pitch back.
    if (ch.effect === 0) {
      if (ch.param > 0) ch.outPeriod = ch.period;
    } else if ((ch.effect === 0x04 || ch.effect === 0x06) && effect !== 0x04 && effect !== 0x06) {
      ch.outPeriod = ch.period;
    }
    ch.effect = effect;
    ch.param = param;
    ch.rowNote = note;
    ch.rowInstrument = instrument;
    ch.delayedCell = null;

    let ins = instrument;
    if (ins > 0) {
      if (ins <= 128) ch.instrumentNumber = ins;
      else ins = 0;
    }

    let checkEffects = true;
    if (effect === 0x0e) {
      if (param >= 0xd1 && param <= 0xdf) return; // note delay, see ft2Effects
      if (param === 0x90) checkEffects = false;
    }
    if (checkEffects) {
      if (vol >> 4 === 0x0f) {
        if (vol & 0x0f) ch.tonePortaSpeed = (vol & 0x0f) << 4;
        this.ft2PreparePorta(ch, note, ins);
        this.ft2TickZero(ch);
        return;
      }
      if (effect === 0x03 || effect === 0x05) {
        if (effect === 0x03 && param) ch.tonePortaSpeed = param;
        this.ft2PreparePorta(ch, note, ins);
        this.ft2TickZero(ch);
        return;
      }
      if (effect === 0x14 && param === 0) {
        this.ft2KeyOff(ch);
        if (ins) this.ft2ResetVolumes(ch);
        this.ft2TickZero(ch);
        return;
      }
      if (note === 0) {
        if (ins) {
          this.ft2ResetVolumes(ch);
          this.ft2TriggerInstrument(ch);
        }
        this.ft2TickZero(ch);
        return;
      }
    }
    if (note === NOTE_KEY_OFF) {
      this.ft2KeyOff(ch);
      if (ins) this.ft2ResetVolumes(ch);
      this.ft2TickZero(ch);
      return;
    }
    // The first note on a channel takes the instrument's defaults even
    // without an instrument number of its own.
    const first = ch.sample === null;
    this.ft2TriggerNote(ch, note, effect, param);
    if (ins || (first && ch.sample)) {
      this.ft2ResetVolumes(ch);
      this.ft2TriggerInstrument(ch);
    }
    this.ft2TickZero(ch);
  }

  /** Starts `note` (0 = the channel's last note) with the instrument last named. */
  private ft2TriggerNote(ch: Channel, note: number, effect: number, param: number): void {
    if (note === NOTE_KEY_OFF) {
      this.ft2KeyOff(ch);
      return;
    }
    if (note === 0) {
      note = ch.note;
      if (note === 0) return;
    }
    ch.note = note;
    const ins = this.song.instruments[ch.instrumentNumber - 1] ?? null;
    ch.instrument = ins;
    if (note > 96) note = 96;
    const sample = ins ? (ins.samples[ins.keymap[note - 1] ?? 0] ?? null) : null;
    ch.relativeNote = sample?.relativeNote ?? 0;
    const note2 = note + ch.relativeNote;
    if (note2 >= 120) return;
    if (!sample || sample.data.length === 0) {
      ch.sample = sample;
      ch.active = false;
      ch.oldVolume = sample?.volume ?? 0;
      return;
    }
    ch.oldVolume = sample.volume;
    ch.oldPanning = sample.usePanning === false ? ch.panning : sample.panning;
    ch.finetune = effect === 0x0e && param >> 4 === 0x05 ? (param & 0x0f) * 16 - 128 : sample.finetune;
    if (note2 > 0) ch.period = ch.outPeriod = this.ft2Period(note2 - 1, ch.finetune);

    let start = 0;
    if (effect === 0x09) {
      if (param) ch.offsetMem = param;
      start = ch.offsetMem << 8;
    }
    ch.sample = sample;
    // An offset past the end stops the note, looped or not.
    if (start >= sample.data.length) {
      ch.active = false;
      return;
    }
    this.startVoice(ch, start);
  }

  private startVoice(ch: Channel, pos: number): void {
    ch.pos = pos;
    ch.dir = 1;
    ch.active = true;
    // Start from silence so a retriggered sample does not click.
    ch.gainL = ch.gainR = 0;
    ch.targetL = ch.targetR = -1; // forces a new ramp in updateChannel
    ch.rampLeft = 0;
  }

  private ft2PreparePorta(ch: Channel, note: number, ins: number): void {
    if (note === NOTE_KEY_OFF) {
      this.ft2KeyOff(ch);
    } else if (note > 0) {
      const real = note - 1 + ch.relativeNote;
      if (real >= 0 && real < 120) {
        ch.targetPeriod = this.ft2Period(real, ch.finetune);
        ch.portaDirection = ch.targetPeriod === ch.period ? 0 : ch.targetPeriod > ch.period ? 1 : 2;
      }
    }
    if (ins) {
      this.ft2ResetVolumes(ch);
      if (note !== NOTE_KEY_OFF) this.ft2TriggerInstrument(ch);
    }
  }

  private ft2ResetVolumes(ch: Channel): void {
    ch.volume = ch.outVolume = ch.oldVolume;
    ch.panning = ch.oldPanning;
  }

  /** Restarts envelopes, fadeout and auto-vibrato of the instrument that plays. */
  private ft2TriggerInstrument(ch: Channel): void {
    if (!(ch.vibratoWave & 4)) ch.vibratoPos = 0;
    if (!(ch.tremoloWave & 4)) ch.tremoloPos = 0;
    ch.tremorPos = 0;
    ch.keyOn = true;
    const ins = ch.instrument;
    if (!ins) return;
    if (ins.volumeEnvelope.enabled) {
      ch.volEnv.tick = -1;
      ch.volEnv.pos = 0;
    }
    if (ins.panningEnvelope.enabled) {
      ch.panEnv.tick = -1;
      ch.panEnv.pos = 0;
    }
    ch.fading = true;
    ch.fadeout = 32768;
    if (ins.vibratoDepth > 0) {
      ch.autoVibPos = 0;
      if (ins.vibratoSweep > 0) {
        ch.autoVibAmp = 0;
        ch.autoVibSweep = Math.floor((ins.vibratoDepth << 8) / ins.vibratoSweep);
      } else {
        ch.autoVibAmp = ins.vibratoDepth << 8;
        ch.autoVibSweep = 0;
      }
    }
  }

  private ft2KeyOff(ch: Channel): void {
    ch.keyOn = false;
    const ins = ch.instrument;
    const ve = ins?.volumeEnvelope;
    if (ve?.enabled && ve.points.length) {
      const x = ve.points[Math.min(ch.volEnv.pos, ve.points.length - 1)]!.x;
      if (ch.volEnv.tick >= x) ch.volEnv.tick = x - 1;
    } else {
      ch.volume = ch.outVolume = 0;
    }
    const pe = ins?.panningEnvelope;
    if (pe?.enabled && pe.points.length) {
      const x = pe.points[Math.min(ch.panEnv.pos, pe.points.length - 1)]!.x;
      if (ch.panEnv.tick >= x) ch.panEnv.tick = x - 1;
    }
  }

  private ft2SetVolume(ch: Channel, volume: number): void {
    ch.volume = ch.outVolume = Math.max(0, Math.min(64, volume));
  }

  private ft2SetPeriod(ch: Channel, period: number): void {
    ch.period = ch.outPeriod = Math.max(1, Math.min(this.ft2MaxPeriod, period));
  }

  private ft2TickZero(ch: Channel): void {
    const vol = ch.volCmd;
    const v = vol & 0x0f;
    switch (vol >> 4) {
      case 0x1: case 0x2: case 0x3: case 0x4:
        this.ft2SetVolume(ch, vol - 0x10);
        break;
      case 0x5:
        if (vol === 0x50) this.ft2SetVolume(ch, 64);
        break;
      case 0x8:
        this.ft2SetVolume(ch, ch.volume - v);
        break;
      case 0x9:
        this.ft2SetVolume(ch, ch.volume + v);
        break;
      case 0xa:
        if (v) ch.vibratoSpeed = v << 2;
        break;
      case 0xc:
        ch.panning = v << 4;
        break;
    }

    const effect = ch.effect;
    const param = ch.param;
    const x = param >> 4;
    const y = param & 0x0f;
    switch (effect) {
      case 0x08:
        ch.panning = param;
        break;
      case 0x0b:
        this.jumpOrder = param;
        this.breakPos = 0;
        this.posJumpFlag = true;
        break;
      case 0x0c:
        this.ft2SetVolume(ch, param);
        break;
      case 0x0d: {
        const row = x * 10 + y;
        this.breakPos = row <= 63 ? row : 0;
        this.posJumpFlag = true;
        break;
      }
      case 0x0e:
        switch (x) {
          case 0x1:
            if (y) ch.fineUpMem = y;
            this.ft2SetPeriod(ch, ch.period - this.slideUnits(ch.fineUpMem));
            break;
          case 0x2:
            if (y) ch.fineDownMem = y;
            this.ft2SetPeriod(ch, ch.period + this.slideUnits(ch.fineDownMem));
            break;
          case 0x3:
            ch.glissando = y !== 0;
            break;
          case 0x4:
            ch.vibratoWave = y;
            break;
          case 0x6:
            if (y === 0) {
              ch.loopRow = this.row;
            } else if (ch.loopCount === 0) {
              ch.loopCount = y;
              this.breakPos = ch.loopRow;
              this.breakFlag = true;
            } else if (--ch.loopCount > 0) {
              this.breakPos = ch.loopRow;
              this.breakFlag = true;
            }
            break;
          case 0x7:
            ch.tremoloWave = y;
            break;
          case 0x8:
            ch.panning = y * 17;
            break;
          case 0xa:
            if (y) ch.fineVolUpMem = y;
            this.ft2SetVolume(ch, ch.volume + ch.fineVolUpMem);
            break;
          case 0xb:
            if (y) ch.fineVolDownMem = y;
            this.ft2SetVolume(ch, ch.volume - ch.fineVolDownMem);
            break;
          case 0xc:
            if (y === 0) this.ft2SetVolume(ch, 0);
            break;
          case 0xe:
            if (this.pattDelTime2 === 0) this.pattDelTime = y + 1;
            break;
        }
        break;
      case 0x0f:
        if (param >= 32) this.tempo = param;
        else if (param > 0) this.speed = param;
        break;
      case 0x10: // Gxx
        this.globalVolume = Math.min(64, param);
        break;
      case 0x15: // Lxx
        this.ft2SetEnvelopePos(ch, param);
        break;
      case 0x1b:
        this.ft2MultiRetrig(ch, param, true);
        break;
      case 0x16: // Mxx: channel volume (IT)
        ch.channelVolume = Math.min(64, param);
        break;
      case 0x17: // Nxy: channel volume slide (IT), NxF and NFy fine
        if (param) ch.channelVolSlideMem = param;
        {
          const m = ch.channelVolSlideMem;
          if ((m & 0x0f) === 0x0f && m >> 4) ch.channelVolume = Math.min(64, ch.channelVolume + (m >> 4));
          else if (m >> 4 === 0x0f && m & 0x0f) ch.channelVolume = Math.max(0, ch.channelVolume - (m & 0x0f));
        }
        break;
      case 0x21: // X1y / X2y
        if (x === 1) {
          if (y) ch.extraFineUpMem = y;
          this.ft2SetPeriod(ch, ch.period - (this.song.linearFrequency ? ch.extraFineUpMem : ch.extraFineUpMem / 4));
        } else if (x === 2) {
          if (y) ch.extraFineDownMem = y;
          this.ft2SetPeriod(ch, ch.period + (this.song.linearFrequency ? ch.extraFineDownMem : ch.extraFineDownMem / 4));
        }
        break;
    }
  }

  /** Effects of the ticks after the first, and of the first tick of rows repeated by EEx. */
  private ft2Effects(ch: Channel): void {
    const t = this.tick;
    const vol = ch.volCmd;
    const v = vol & 0x0f;
    switch (vol >> 4) {
      case 0x6:
        this.ft2SetVolume(ch, ch.volume - v);
        break;
      case 0x7:
        this.ft2SetVolume(ch, ch.volume + v);
        break;
      case 0xb:
        if (v) ch.vibratoDepth = v;
        this.ft2Vibrato(ch);
        break;
      case 0xd:
        ch.panning = Math.max(0, ch.panning - v);
        break;
      case 0xe:
        ch.panning = Math.min(255, ch.panning + v);
        break;
      case 0xf:
        this.ft2Porta(ch);
        break;
    }

    const effect = ch.effect;
    const param = ch.param;
    if (effect === 0 && param === 0) return;
    const x = param >> 4;
    const y = param & 0x0f;
    switch (effect) {
      case 0x00: {
        // FT2 reads its arpeggio table with the tick counter running backwards.
        let pos = this.speed - t;
        pos = pos > 16 ? 2 : pos === 16 ? 0 : pos % 3;
        ch.outPeriod = pos === 0 ? ch.period : this.ft2Relocate(ch.period, pos === 1 ? x : y, ch);
        break;
      }
      case 0x01:
        if (param) ch.portaUpMem = param;
        this.ft2SetPeriod(ch, ch.period - this.slideUnits(ch.portaUpMem));
        break;
      case 0x02:
        if (param) ch.portaDownMem = param;
        this.ft2SetPeriod(ch, ch.period + this.slideUnits(ch.portaDownMem));
        break;
      case 0x03:
        this.ft2Porta(ch);
        break;
      case 0x04:
        if (y) ch.vibratoDepth = y;
        if (x) ch.vibratoSpeed = x << 2;
        this.ft2Vibrato(ch);
        break;
      case 0x05:
        this.ft2Porta(ch);
        this.ft2VolSlide(ch, param);
        break;
      case 0x06:
        this.ft2Vibrato(ch);
        this.ft2VolSlide(ch, param);
        break;
      case 0x07:
        this.ft2Tremolo(ch, param);
        break;
      case 0x0a:
        this.ft2VolSlide(ch, param);
        break;
      case 0x0e:
        if (x === 0x9) {
          if (y && t % y === 0) {
            this.ft2TriggerNote(ch, 0, 0, 0);
            this.ft2TriggerInstrument(ch);
          }
        } else if (x === 0xc) {
          if (t === y) this.ft2SetVolume(ch, 0);
        } else if (x === 0xd) {
          if (t === y) this.ft2NoteDelay(ch);
        }
        break;
      case 0x11: {
        const p = param || ch.globalVolSlideMem;
        ch.globalVolSlideMem = p;
        if (p & 0xf0) this.globalVolume = Math.min(64, this.globalVolume + (p >> 4));
        else this.globalVolume = Math.max(0, this.globalVolume - p);
        break;
      }
      case 0x14:
        if (t === (param & 31)) this.ft2KeyOff(ch);
        break;
      case 0x17: {
        const m = ch.channelVolSlideMem;
        if ((m & 0x0f) === 0x0f || m >> 4 === 0x0f) break; // fine slides act on tick 0
        if (m >> 4) ch.channelVolume = Math.min(64, ch.channelVolume + (m >> 4));
        else ch.channelVolume = Math.max(0, ch.channelVolume - (m & 0x0f));
        break;
      }
      case 0x19: {
        const p = param || ch.panSlideMem;
        ch.panSlideMem = p;
        if (p & 0xf0) ch.panning = Math.min(255, ch.panning + (p >> 4));
        else ch.panning = Math.max(0, ch.panning - p);
        break;
      }
      case 0x1b:
        this.ft2MultiRetrig(ch, param);
        break;
      case 0x1d: {
        const p = param || ch.tremorMem;
        ch.tremorMem = p;
        let on = ch.tremorPos & 0x80;
        let left = (ch.tremorPos & 0x7f) - 1;
        if (left < 0) {
          if (on) {
            on = 0;
            left = p & 0x0f;
          } else {
            on = 0x80;
            left = p >> 4;
          }
        }
        ch.tremorPos = on | left;
        ch.outVolume = on ? ch.volume : 0;
        break;
      }
    }
  }

  private ft2NoteDelay(ch: Channel): void {
    // Unlike a note on tick 0, a delayed note restarts the envelopes even without an instrument.
    this.ft2TriggerNote(ch, ch.rowNote, 0, 0);
    if (ch.rowInstrument) this.ft2ResetVolumes(ch);
    this.ft2TriggerInstrument(ch);
    const vol = ch.volCmd;
    if (vol >= 0x10 && vol <= 0x50) this.ft2SetVolume(ch, vol - 0x10);
    else if (vol >> 4 === 0xc) ch.panning = (vol & 0x0f) << 4;
  }

  /** Rxy, which counts ticks since its last retrigger, with FT2's odd first tick. */
  private ft2MultiRetrig(ch: Channel, param: number, firstTick = false): void {
    if (param & 0x0f) ch.retrigSpeed = param & 0x0f;
    if (param >> 4) ch.retrigVolume = param >> 4;
    let count = ch.retrigCount;
    const vol = ch.volCmd;
    if (firstTick) {
      if (ch.rowInstrument && ch.rowNote !== NOTE_KEY_OFF) count = 1;
      // A set volume other than zero holds the counter on the first tick.
      if (vol > 0x10 && vol <= 0x50) {
        ch.retrigCount = count;
        return;
      }
    }
    const note = ch.rowNote > 0 && ch.rowNote !== NOTE_KEY_OFF;
    if (count >= ch.retrigSpeed && !(firstTick && note)) {
      count = 0;
      this.ft2Retrig(ch);
    }
    ch.retrigCount = count + 1;
  }

  private ft2Retrig(ch: Channel): void {
    let v = ch.volume;
    switch (ch.retrigVolume) {
      case 0x1: v -= 1; break;
      case 0x2: v -= 2; break;
      case 0x3: v -= 4; break;
      case 0x4: v -= 8; break;
      case 0x5: v -= 16; break;
      case 0x6: v = (v >> 1) + (v >> 3) + (v >> 4); break;
      case 0x7: v >>= 1; break;
      case 0x9: v += 1; break;
      case 0xa: v += 2; break;
      case 0xb: v += 4; break;
      case 0xc: v += 8; break;
      case 0xd: v += 16; break;
      case 0xe: v = (v >> 1) + v; break;
      case 0xf: v += v; break;
    }
    this.ft2SetVolume(ch, v);
    const vol = ch.volCmd;
    if (vol >= 0x10 && vol <= 0x50) this.ft2SetVolume(ch, vol - 0x10);
    else if (vol >> 4 === 0xc) ch.panning = (vol & 0x0f) << 4;
    this.ft2TriggerNote(ch, 0, 0, 0);
  }

  private ft2VolSlide(ch: Channel, param: number): void {
    const p = param || ch.volSlideMem;
    ch.volSlideMem = p;
    if (p & 0xf0) this.ft2SetVolume(ch, ch.volume + (p >> 4));
    else this.ft2SetVolume(ch, ch.volume - p);
  }

  private ft2Porta(ch: Channel): void {
    if (ch.portaDirection === 0) return;
    const speed = this.slideUnits(ch.tonePortaSpeed);
    if (ch.portaDirection > 1) {
      ch.period -= speed;
      if (ch.period <= ch.targetPeriod) {
        ch.portaDirection = 1;
        ch.period = ch.targetPeriod;
      }
    } else {
      ch.period += speed;
      if (ch.period >= ch.targetPeriod) {
        ch.portaDirection = 1;
        ch.period = ch.targetPeriod;
      }
    }
    ch.outPeriod = ch.glissando ? this.ft2Relocate(ch.period, 0, ch) : ch.period;
  }

  private ft2Vibrato(ch: Channel): void {
    const pos = ch.vibratoPos;
    let v = (pos >> 2) & 0x1f;
    switch (ch.vibratoWave & 3) {
      case 0: v = FT2_VIB_TAB[v]!; break;
      case 1: v <<= 3; if (pos >= 128) v = ~v & 0xff; break;
      default: v = 255;
    }
    v = (v * ch.vibratoDepth) >> 5;
    const offset = this.song.linearFrequency ? v : v / 4;
    ch.outPeriod = pos >= 128 ? ch.period - offset : ch.period + offset;
    ch.vibratoPos = (pos + ch.vibratoSpeed) & 0xff;
  }

  private ft2Tremolo(ch: Channel, param: number): void {
    if (param & 0x0f) ch.tremoloDepth = param & 0x0f;
    if (param >> 4) ch.tremoloSpeed = (param >> 4) << 2;
    const pos = ch.tremoloPos;
    let v = (pos >> 2) & 0x1f;
    switch ((ch.tremoloWave) & 3) {
      case 0: v = FT2_VIB_TAB[v]!; break;
      // FT2 bug: the ramp looks at the vibrato position for its direction.
      case 1: v <<= 3; if (ch.vibratoPos >= 128) v = ~v & 0xff; break;
      default: v = 255;
    }
    v = (v * ch.tremoloDepth) >> 6;
    ch.outVolume = pos >= 128 ? Math.max(0, ch.volume - v) : Math.min(64, ch.volume + v);
    ch.tremoloPos = (pos + ch.tremoloSpeed) & 0xff;
  }

  /** Lxx: FT2 moves the volume envelope, and the panning envelope only if the volume one has sustain. */
  private ft2SetEnvelopePos(ch: Channel, param: number): void {
    const ins = ch.instrument;
    if (!ins) return;
    const set = (env: Envelope, st: EnvState) => {
      const pts = env.points;
      if (!pts.length) return;
      st.tick = param - 1;
      let point = 0;
      let update = true;
      let tick = param;
      if (pts.length > 1) {
        point++;
        for (let i = 0; i < pts.length - 1; i++) {
          if (tick < pts[point]!.x) {
            point--;
            tick -= pts[point]!.x;
            if (tick === 0) {
              update = false;
              break;
            }
            const dx = pts[point + 1]!.x - pts[point]!.x;
            if (dx <= 0) break;
            const y0 = pts[point]!.y;
            st.delta = Math.trunc(((pts[point + 1]!.y - y0) * 256) / dx);
            st.value = st.delta * (tick - 1) + y0 * 256;
            point++;
            update = false;
            break;
          }
          point++;
        }
        if (update) point--;
      }
      if (update) {
        st.delta = 0;
        st.value = pts[point]!.y * 256;
      }
      st.pos = Math.max(0, Math.min(point, pts.length - 1));
    };
    if (ins.volumeEnvelope.enabled) set(ins.volumeEnvelope, ch.volEnv);
    if (ins.volumeEnvelope.sustain && ins.panningEnvelope.enabled) set(ins.panningEnvelope, ch.panEnv);
  }

  /** One tick of an FT2 envelope; returns its value, 0..64. */
  private ft2Envelope(env: Envelope, st: EnvState, keyOn: boolean): number {
    const pts = env.points;
    const len = pts.length;
    if (!len) return 64;
    let pos = Math.min(st.pos, len - 1);
    let interpolated = false;
    if (++st.tick === pts[pos]!.x) {
      st.value = pts[pos]!.y * 256;
      pos++;
      if (env.loop) {
        pos--;
        if (pos === env.loopEnd && (!env.sustain || pos !== env.sustainPoint || !keyOn)) {
          pos = Math.min(env.loopStart, len - 1);
          st.tick = pts[pos]!.x;
          st.value = pts[pos]!.y * 256;
        }
        pos++;
      }
      if (pos < len) {
        if (env.sustain && keyOn && pos - 1 === env.sustainPoint) {
          st.delta = 0;
        } else {
          st.pos = pos;
          const dx = pts[pos]!.x - pts[pos - 1]!.x;
          if (dx > 0) {
            st.delta = Math.trunc(((pts[pos]!.y - pts[pos - 1]!.y) * 256) / dx);
            interpolated = true;
          } else {
            st.delta = 0;
          }
        }
      } else {
        st.delta = 0;
      }
    }
    if (!interpolated) st.value = Math.max(0, Math.min(64 * 256, st.value + st.delta));
    return st.value / 256;
  }

  private ft2Update(ch: Channel): void {
    const ins = ch.instrument;
    let period = ch.outPeriod;
    let envVol = 64;
    let envPan = 32;
    if (ins) {
      const ve = ins.volumeEnvelope;
      // The fadeout speed comes from the instrument that plays now, which a
      // note without instrument number can change after key off.
      if (!ch.keyOn && ch.fading && ins.fadeout > 0) ch.fadeout = Math.max(0, ch.fadeout - ins.fadeout);
      if (ve.enabled) envVol = this.ft2Envelope(ve, ch.volEnv, ch.keyOn);
      if (ins.panningEnvelope.enabled) envPan = this.ft2Envelope(ins.panningEnvelope, ch.panEnv, ch.keyOn);

      if (ins.vibratoDepth > 0) {
        let amp: number;
        if (ch.autoVibSweep > 0) {
          amp = ch.autoVibSweep;
          // FT2 bug: after key off the sweep step itself is used as depth.
          if (ch.keyOn) {
            amp += ch.autoVibAmp;
            if (amp >> 8 > ins.vibratoDepth) {
              amp = ins.vibratoDepth << 8;
              ch.autoVibSweep = 0;
            }
            ch.autoVibAmp = amp;
          }
        } else {
          amp = ch.autoVibAmp;
        }
        const pos = (ch.autoVibPos = (ch.autoVibPos + ins.vibratoRate) & 0xff);
        let wave: number;
        switch (ins.vibratoType & 3) {
          case 1: wave = pos > 127 ? 64 : -64; break;
          case 2: wave = (((pos >> 1) + 64) & 127) - 64; break;
          case 3: wave = ((64 - (pos >> 1)) & 127) - 64; break;
          default: wave = FT2_AUTO_VIB_SINE[pos]!;
        }
        const delta = (wave * amp) >> 14;
        period += this.song.linearFrequency ? delta : delta / 4;
      }
    }
    if (period >= this.ft2MaxPeriod + 1) period = 0;

    ch.step = this.ft2Frequency(period) / this.sampleRate;
    const gain =
      (ch.outVolume / 64) * (envVol / 64) * (ch.fadeout / 32768) * (this.globalVolume / 64) * (ch.channelVolume / 64);
    const pan = ch.panning;
    ch.outPanning = Math.max(0, Math.min(255, pan + ((envPan - 32) * (128 - Math.abs(pan - 128))) / 32));
    this.setGains(ch, gain);
  }

  // -------------------------------------------------------- per tick output

  private updateChannel(ch: Channel): void {
    if (this.ft2) {
      this.ft2Update(ch);
      return;
    }
    // Vibrato/tremolo offsets are computed during tickEffects of this tick only.
    const vibrato = ch.vibratoOffset;
    const tremolo = ch.tremoloOffset;
    ch.vibratoOffset = 0;
    ch.tremoloOffset = 0;

    let period = ch.period;

    if (ch.effect === 0x00 && ch.param !== 0 && ch.delayedCell === null) {
      const step = this.tick % 3;
      const semis = step === 1 ? ch.param >> 4 : step === 2 ? ch.param & 0x0f : 0;
      if (semis) {
        period = this.song.linearFrequency ? period - semis * 64 : period * Math.pow(2, -semis / 12);
      }
    }
    period += vibrato;

    const ins = ch.instrument;
    let envVol = 64;
    let envPan = 32;
    if (ins && !this.isMod) {
      const ve = ins.volumeEnvelope;
      if (ve.enabled) {
        envVol = envelopeValue(ve, ch.volEnvTick);
        ch.volEnvTick = envelopeAdvance(ve, ch.volEnvTick, ch.keyOn);
        // Fadeout only runs with an enabled volume envelope; without one key off cuts the note.
        const fading = !ins.fadeAfterEnvelope || ve.loop || ch.volEnvTick >= ve.points[ve.points.length - 1]!.x;
        if (!ch.keyOn && fading) ch.fadeout = Math.max(0, ch.fadeout - ins.fadeout);
      }
      const pe = ins.panningEnvelope;
      if (pe.enabled) {
        envPan = envelopeValue(pe, ch.panEnvTick);
        ch.panEnvTick = envelopeAdvance(pe, ch.panEnvTick, ch.keyOn);
      }

      if (ins.vibratoDepth && ins.vibratoRate) {
        let depth = ins.vibratoDepth;
        if (ins.vibratoSweep && ch.autoVibSweep < ins.vibratoSweep) {
          depth = (depth * ch.autoVibSweep) / ins.vibratoSweep;
          ch.autoVibSweep++;
        }
        const wave = AUTO_VIBRATO_WAVEFORMS[ins.vibratoType & 3]![(ch.autoVibPos >> 2) & 63]!;
        const delta = (wave * depth) / 64;
        period += this.song.linearFrequency ? delta : delta / 4;
        ch.autoVibPos = (ch.autoVibPos + ins.vibratoRate) & 255;
      }
    }

    ch.outPeriod = Math.max(1, period);
    const freq = this.frequency(ch.outPeriod);
    ch.step = freq / this.sampleRate;

    let volume = Math.max(0, Math.min(64, ch.volume + tremolo));
    if (ch.effect === 0x1d && !ch.tremorOn) volume = 0;
    ch.outVolume = volume;
    const gain = (volume / 64) * (envVol / 64) * (ch.fadeout / 32768) * (this.globalVolume / 64) * (ch.channelVolume / 64);

    const pan = ch.panning;
    ch.outPanning = Math.max(0, Math.min(255, pan + ((envPan - 32) * (128 - Math.abs(pan - 128))) / 32));
    this.setGains(ch, gain);
  }

  /** Sets the channel's target gains from `gain` and its output panning, ramped unless ramps are off. */
  private setGains(ch: Channel, gain: number): void {
    const p = ch.outPanning / 255;
    const targetL = ch.active ? gain * Math.sqrt(1 - p) : 0;
    const targetR = ch.active ? gain * Math.sqrt(p) : 0;

    if (!this.volumeRamps) {
      ch.targetL = ch.gainL = targetL;
      ch.targetR = ch.gainR = targetR;
      ch.rampLeft = 0;
    } else if (targetL !== ch.targetL || targetR !== ch.targetR || ch.rampLeft > 0) {
      ch.targetL = targetL;
      ch.targetR = targetR;
      ch.rampLeft = this.rampSamples;
      ch.rampL = (targetL - ch.gainL) / this.rampSamples;
      ch.rampR = (targetR - ch.gainR) / this.rampSamples;
    }
  }

  // ------------------------------------------------------------------ mixing

  private mixChannel(
    ch: Channel,
    left: Float32Array,
    right: Float32Array,
    offset: number,
    count: number,
    tap?: Float32Array,
    silent = false,
  ): void {
    const sample = ch.sample;
    if (!ch.active || !sample) return;
    const data = sample.data;
    const len = data.length;
    const looped = sample.loopType !== LoopType.None && sample.loopLength > 0;
    const loopStart = sample.loopStart;
    const loopEnd = sample.loopStart + sample.loopLength;
    const pingPong = sample.loopType === LoopType.PingPong;

    let pos = ch.pos;
    let dir = ch.dir;
    let gainL = ch.gainL;
    let gainR = ch.gainR;
    const step = ch.step;
    const mode = this.activeResampler;
    const smooth = mode === 'linear';
    const cubic = mode === 'cubic';
    const sinc = mode === 'sinc';
    const blep = mode === 'amiga';
    // Frame j as the loop plays it: past the loop end it continues from the loop start (or mirrors), past the end it is silent.
    const frameAt = (j: number): number => {
      if (looped && j >= loopEnd) {
        const over = (j - loopEnd) % sample.loopLength;
        j = pingPong ? loopEnd - 1 - over : loopStart + over;
      }
      return j >= 0 && j < len ? data[j]! : 0;
    };
    let held = ch.held;
    let blepNext = ch.blepNext;

    for (let i = offset, end = offset + count; i < end; i++) {
      const idx = pos | 0;
      const frac = pos - idx;
      const a = data[idx]!;
      let nextIdx = idx + 1;
      if (looped && nextIdx >= loopEnd) nextIdx = pingPong ? idx : loopStart;
      const b = nextIdx < len ? data[nextIdx]! : 0;
      let s = smooth ? a + (b - a) * frac : a;
      if (cubic) {
        // Catmull-Rom through the frames around the read position.
        const prevIdx = Math.max(0, idx - 1);
        let next2 = nextIdx + 1;
        if (looped && next2 >= loopEnd) next2 = pingPong ? nextIdx : loopStart + (next2 - loopEnd);
        const p0 = data[prevIdx]!;
        const p3 = next2 < len ? data[next2]! : 0;
        const t = frac;
        s = a + 0.5 * t * (b - p0 + t * (2 * p0 - 5 * a + 4 * b - p3 + t * (3 * (a - b) + p3 - p0)));
      } else if (sinc) {
        const k = Math.round(frac * SINC_PHASES) * SINC_TAPS;
        s = 0;
        for (let t = 0; t < SINC_TAPS; t++) s += SINC_TABLE[k + t]! * frameAt(idx - 3 + t);
      }
      if (blep) {
        // Paula holds each frame; a polyBLEP smooths the steps so they do not
        // alias back below the output Nyquist frequency.
        s += blepNext;
        blepNext = 0;
        if (a !== held) {
          const delta = a - held;
          const d = Math.min(1, frac / step);
          s -= (delta * (1 - d) * (1 - d)) / 2;
          blepNext = (delta * d * d) / 2;
          held = a;
        }
      }

      if (ch.rampLeft > 0) {
        gainL += ch.rampL;
        gainR += ch.rampR;
        if (--ch.rampLeft === 0) {
          gainL = ch.targetL;
          gainR = ch.targetR;
        }
      }
      // A muted channel runs on so it is in step when unmuted, but adds nothing.
      if (!silent) {
        left[i]! += s * gainL;
        right[i]! += s * gainR;
        if (tap) tap[i] = s * (gainL + gainR);
      }

      pos += step * dir;
      if (looped) {
        if (pingPong) {
          if (dir > 0 && pos >= loopEnd) {
            pos = loopEnd - (pos - loopEnd) - 1e-6;
            dir = -1;
          } else if (dir < 0 && pos < loopStart) {
            pos = loopStart + (loopStart - pos);
            dir = 1;
          }
          // Before the loop is first reached the sample plays from its start.
          if (pos >= loopEnd || (dir < 0 && pos < loopStart)) pos = loopStart;
        } else if (pos >= loopEnd) {
          pos = loopStart + ((pos - loopStart) % sample.loopLength);
        }
      } else if (pos >= len) {
        ch.active = false;
        break;
      }
    }

    ch.pos = pos;
    ch.dir = dir;
    ch.held = held;
    ch.blepNext = blepNext;
    ch.gainL = gainL;
    ch.gainR = gainR;
  }

  /** Plays `note` on instrument `ins` (1-based) through the preview voice, with envelopes. */
  previewNote(ins: number, note: number): void {
    const ch = this.preview;
    ch.instrumentNumber = ins;
    ch.instrument = this.song.instruments[ins - 1] ?? null;
    ch.effect = 0;
    ch.param = 0;
    ch.delayedCell = null;
    if (this.ft2) {
      ch.volCmd = 0;
      this.ft2TriggerNote(ch, note, 0, 0);
      if (ch.active) {
        this.ft2ResetVolumes(ch);
        this.ft2TriggerInstrument(ch);
      }
      return;
    }
    this.triggerNote(ch, note, null);
    if (ch.instrument && ch.active) this.resetInstrumentState(ch, ch.instrument);
  }

  /** Every voice that is sounding right now, song channels first, then the preview voice. */
  voices(): VoiceState[] {
    const out: VoiceState[] = [];
    const add = (ch: Channel, channel: number) => {
      if (!ch.active || !ch.instrument || !ch.sample) return;
      // Released and faded out: the voice still runs but is silent.
      if (!ch.keyOn && (ch.volume === 0 || ch.fadeout === 0)) return;
      out.push({
        channel,
        instrument: ch.instrumentNumber,
        sample: ch.instrument.samples.indexOf(ch.sample),
        note: ch.note,
        pos: ch.pos,
        volEnvTick: this.ft2 ? envelopeTick(ch.instrument.volumeEnvelope, ch.volEnv) : ch.volEnvTick,
        panEnvTick: this.ft2 ? envelopeTick(ch.instrument.panningEnvelope, ch.panEnv) : ch.panEnvTick,
      });
    };
    if (this.playing) this.channels.forEach(add);
    add(this.preview, -1);
    return out;
  }

  /**
   * Releases the preview note: envelopes go past sustain and fade out.
   * A one-shot sample without a volume envelope plays to its end instead of
   * being cut, so a quick tap on a touch screen still sounds the whole sample.
   */
  previewOff(): void {
    const ch = this.preview;
    if (ch.instrument && !ch.instrument.volumeEnvelope.enabled && ch.sample?.loopType === LoopType.None) {
      ch.keyOn = false;
      ch.fading = false;
      return;
    }
    if (this.ft2) this.ft2KeyOff(ch);
    else this.keyOff(ch);
  }

  /**
   * Starts recording what each channel plays, after volume and before
   * panning, for scopes. `size` is how many recent frames are kept.
   */
  enableScopes(size: number): void {
    this.scopeRings = this.channels.map(() => new Float32Array(size));
    this.scopeTaps = this.channels.map(() => new Float32Array(128));
    this.scopePos = 0;
  }

  /** The kept frames per channel, oldest first. Silent channels read as zeros. */
  readScopes(): Float32Array[] {
    return this.scopeRings.map((ring) => {
      const out = new Float32Array(ring.length);
      out.set(ring.subarray(this.scopePos));
      out.set(ring.subarray(0, this.scopePos), ring.length - this.scopePos);
      return out;
    });
  }

  private pushScopes(frames: number): void {
    const size = this.scopeRings[0]?.length ?? 0;
    if (!size) return;
    this.scopeRings.forEach((ring, c) => {
      const tap = this.scopeTaps[c]!;
      let pos = this.scopePos;
      for (let i = 0; i < frames; i++) {
        ring[pos] = tap[i]!;
        if (++pos === size) pos = 0;
      }
    });
    this.scopePos = (this.scopePos + frames) % size;
  }

  /** Per channel snapshot for UI meters. */
  channelLevels(): number[] {
    return this.channels.map((ch) => (ch.active ? Math.max(ch.gainL, ch.gainR) : 0));
  }
}

function multiRetrigVolume(volume: number, x: number): number {
  switch (x) {
    case 1: return Math.max(0, volume - 1);
    case 2: return Math.max(0, volume - 2);
    case 3: return Math.max(0, volume - 4);
    case 4: return Math.max(0, volume - 8);
    case 5: return Math.max(0, volume - 16);
    case 6: return Math.floor((volume * 2) / 3);
    case 7: return volume >> 1;
    case 9: return Math.min(64, volume + 1);
    case 0xa: return Math.min(64, volume + 2);
    case 0xb: return Math.min(64, volume + 4);
    case 0xc: return Math.min(64, volume + 8);
    case 0xd: return Math.min(64, volume + 16);
    case 0xe: return Math.min(64, Math.floor((volume * 3) / 2));
    case 0xf: return Math.min(64, volume * 2);
    default: return volume;
  }
}

/** RBJ cookbook low-pass coefficients, normalised by a0. */
function biquadLowPass(hz: number, q: number, rate: number) {
  const w = (2 * Math.PI * Math.min(hz, rate * 0.45)) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function softClip(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x;
}
