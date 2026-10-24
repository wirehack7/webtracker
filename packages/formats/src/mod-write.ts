import { CELL_SIZE, LoopType, NOTE_KEY_OFF, type Sample, type Song } from '@webtracker/engine';

/**
 * ProTracker periods for XM notes 25..84 (Amiga octaves 0..4 at finetune 0).
 * The middle three octaves, notes 37..72, are what ProTracker itself plays.
 */
const PERIODS = [
  1712, 1616, 1525, 1440, 1357, 1281, 1209, 1141, 1077, 1017, 961, 907,
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 340, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
  107, 101, 95, 90, 85, 80, 76, 71, 67, 64, 60, 57,
];
const FIRST_NOTE = 25;
const PT_LOW = 37;
const PT_HIGH = 72;
const MAX_SAMPLES = 31;
const MAX_SAMPLE_FRAMES = 0xffff * 2;
const MAX_PATTERNS = 100;
const ROWS = 64;

export interface SavedMod {
  bytes: Uint8Array;
  /** What did not fit the format and was changed or left out, for the user to read. */
  warnings: string[];
}

function tagFor(channels: number, patterns: number): string {
  if (channels === 4) return patterns > 64 ? 'M!K!' : 'M.K.';
  return channels < 10 ? `${channels}CHN` : `${channels}CH`;
}

/** The sample an instrument plays on C-4, which is the one a MOD instrument becomes. */
function mainSample(song: Song, index: number): Sample | null {
  const ins = song.instruments[index];
  if (!ins) return null;
  return ins.samples[ins.keymap[48] ?? 0] ?? ins.samples[0] ?? null;
}

/**
 * Writes the song as a ProTracker-style MOD. MOD is much smaller than XM, so
 * this converts what it can: notes are shifted by each sample's relative
 * note, volume column commands move to the effect column when it is free,
 * shorter patterns end with a pattern break. Everything else is left out
 * and listed in `warnings`.
 */
export function saveMod(song: Song): SavedMod {
  const warnings = new Set<string>();
  const channels = song.channels;
  if (song.instruments.length > MAX_SAMPLES && song.instruments.slice(MAX_SAMPLES).some((i) => i.samples.length)) {
    warnings.add(`Only the first ${MAX_SAMPLES} instruments are saved.`);
  }
  if (song.instruments.some((i) => i.volumeEnvelope.enabled || i.panningEnvelope.enabled || i.vibratoDepth)) {
    warnings.add('Envelopes and auto-vibrato are not part of MOD.');
  }
  if (song.instruments.some((i) => i.samples.length > 1)) warnings.add('Each instrument keeps only the sample it plays on C-4.');

  const samples = Array.from({ length: MAX_SAMPLES }, (_, i) => mainSample(song, i));
  const orders = song.orders.slice(0, 128);
  if (song.orders.length > 128) warnings.add('The order list is cut to 128 positions.');
  let patternCount = Math.max(...orders) + 1;
  if (patternCount > MAX_PATTERNS) {
    warnings.add(`MOD holds ${MAX_PATTERNS} patterns; positions using higher pattern numbers point to pattern 0.`);
    patternCount = MAX_PATTERNS;
  }

  const sampleBytes = samples.map((s) => (s ? Math.min(s.data.length, MAX_SAMPLE_FRAMES) & ~1 : 0));
  if (samples.some((s) => s && s.data.length > MAX_SAMPLE_FRAMES)) warnings.add('Samples are cut to 128 KB.');
  const size = 1084 + patternCount * ROWS * channels * 4 + sampleBytes.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(size);
  const word = (o: number, v: number) => {
    out[o] = (v >> 8) & 0xff;
    out[o + 1] = v & 0xff;
  };
  const text = (o: number, s: string, n: number) => {
    for (let i = 0; i < n && i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[o + i] = c >= 32 && c < 127 ? c : 32;
    }
  };

  text(0, song.title, 20);
  samples.forEach((s, i) => {
    const o = 20 + i * 30;
    text(o, song.instruments[i]?.name ?? '', 22);
    // ProTracker writes a one-word repeat length for samples without a loop, empty slots included.
    word(o + 28, 1);
    if (!s) return;
    const bytes = sampleBytes[i]!;
    word(o + 22, bytes / 2);
    out[o + 24] = Math.max(-8, Math.min(7, Math.round(s.finetune / 16))) & 0x0f;
    out[o + 25] = Math.max(0, Math.min(64, s.volume));
    if (s.loopType !== LoopType.None && s.loopLength > 0 && bytes > 0) {
      if (s.loopType === LoopType.PingPong) warnings.add('Ping-pong loops become forward loops.');
      const start = Math.min(s.loopStart, bytes) & ~1;
      const length = Math.min(s.loopLength, bytes - start) & ~1;
      word(o + 26, start / 2);
      word(o + 28, Math.max(1, length / 2));
    }
  });

  out[950] = orders.length;
  // 127 is what ProTracker stores when the song restarts from the top.
  out[951] = song.restartPosition > 0 && song.restartPosition < orders.length ? song.restartPosition : 127;
  orders.forEach((p, i) => (out[952 + i] = p < patternCount ? p : 0));
  text(1080, tagFor(channels, patternCount), 4);

  let o = 1084;
  for (let p = 0; p < patternCount; p++) {
    const pattern = song.patterns[p];
    const rows = pattern?.rows ?? ROWS;
    if (rows > ROWS) warnings.add('Patterns longer than 64 rows are cut to 64.');
    for (let row = 0; row < ROWS; row++) {
      for (let ch = 0; ch < channels; ch++) {
        const src = (row * channels + ch) * CELL_SIZE;
        const cell = pattern && row < rows ? pattern.data.subarray(src, src + CELL_SIZE) : new Uint8Array(CELL_SIZE);
        let [note = 0, ins = 0, vol = 0, effect = 0, param = 0] = cell;
        if (ins > MAX_SAMPLES) ins = 0;
        if (effect > 0x0f) {
          warnings.add('XM-only effects (G and above) are left out.');
          effect = 0;
          param = 0;
        }
        // The volume column only fits where the effect column is free.
        if (vol >= 0x10) {
          const v = volumeAsEffect(vol);
          if (v && effect === 0 && param === 0) [effect, param] = v;
          else warnings.add('Some volume column commands did not fit the effect column.');
        }
        let period = 0;
        if (note === NOTE_KEY_OFF) {
          if (effect === 0 && param === 0) [effect, param] = [0x0c, 0];
          else warnings.add('Some key-offs could not become C00.');
        } else if (note > 0) {
          const playing = ins || lastInstrument(song, p, row, ch);
          const shifted = note + (mainSample(song, playing - 1)?.relativeNote ?? 0);
          if (shifted < PT_LOW || shifted > PT_HIGH) warnings.add('Notes outside C-1..B-3 (ProTracker numbering) need an extended-octave player.');
          period = PERIODS[Math.max(0, Math.min(PERIODS.length - 1, shifted - FIRST_NOTE))]!;
        }
        // Shorter patterns end where a pattern break on their last row sends them.
        if (pattern && row === rows - 1 && rows < ROWS && ch === breakChannel(pattern.data, row, channels)) {
          [effect, param] = [0x0d, 0];
        }
        out[o] = (ins & 0xf0) | ((period >> 8) & 0x0f);
        out[o + 1] = period & 0xff;
        out[o + 2] = ((ins & 0x0f) << 4) | effect;
        out[o + 3] = param;
        o += 4;
      }
    }
    if (pattern && rows < ROWS && breakChannel(pattern.data, rows - 1, channels) < 0) {
      warnings.add('Some short patterns had no free effect for the pattern break and play 64 rows.');
    }
  }

  samples.forEach((s, i) => {
    const bytes = sampleBytes[i]!;
    if (!s) return;
    for (let k = 0; k < bytes; k++) out[o + k] = Math.max(-128, Math.min(127, Math.round(s.data[k]! * 128))) & 0xff;
    o += bytes;
  });

  if (song.initialSpeed !== 6 || song.initialTempo !== 125) {
    warnings.add('MOD has no song speed or BPM; put Fxx effects on the first row.');
  }
  return { bytes: out, warnings: [...warnings] };
}

/** First channel on `row` with an empty effect, or -1. */
function breakChannel(data: Uint8Array, row: number, channels: number): number {
  for (let ch = 0; ch < channels; ch++) {
    const o = (row * channels + ch) * CELL_SIZE;
    if (!data[o + 3] && !data[o + 4] && (data[o + 2] ?? 0) < 0x10 && data[o] !== NOTE_KEY_OFF) return ch;
  }
  return -1;
}

/** The instrument last set in this channel, looking back in the same pattern. */
function lastInstrument(song: Song, p: number, row: number, ch: number): number {
  const pattern = song.patterns[p]!;
  for (let r = row; r >= 0; r--) {
    const ins = pattern.data[(r * song.channels + ch) * CELL_SIZE + 1]!;
    if (ins) return ins;
  }
  return 0;
}

/** XM volume column command as a MOD effect and parameter, where there is one. */
function volumeAsEffect(vol: number): [number, number] | null {
  const hi = vol >> 4;
  const lo = vol & 0x0f;
  if (vol >= 0x10 && vol <= 0x50) return [0x0c, vol - 0x10];
  switch (hi) {
    case 0x6:
      return [0x0a, lo];
    case 0x7:
      return [0x0a, lo << 4];
    case 0x8:
      return [0x0e, 0xb0 | lo];
    case 0x9:
      return [0x0e, 0xa0 | lo];
    case 0xb:
      return [0x04, lo];
    case 0xc:
      return [0x08, lo * 17];
    case 0xf:
      return [0x03, lo << 4];
  }
  return null;
}
