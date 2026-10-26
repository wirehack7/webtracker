/** Ready-made envelopes for the instrument editor, plus the clipboard both envelopes share. */
import { emptyEnvelope, type Envelope, type EnvelopePoint } from '@webtracker/engine';
import { msg } from '../i18n/i18n.ts';

export interface EnvelopePreset {
  name: string;
  build(): Envelope;
}

const env = (points: [number, number][], extra: Partial<Envelope> = {}): Envelope => ({
  ...emptyEnvelope(),
  enabled: true,
  points: points.map(([x, y]): EnvelopePoint => ({ x, y })),
  ...extra,
});

export const VOLUME_PRESETS: EnvelopePreset[] = [
  { name: msg('Pluck'), build: () => env([[0, 64], [4, 48], [16, 20], [48, 6], [96, 0]]) },
  { name: msg('Decay'), build: () => env([[0, 64], [128, 0]]) },
  { name: msg('Organ'), build: () => env([[0, 64], [16, 64], [24, 0]], { sustain: true, sustainPoint: 1 }) },
  { name: msg('Pad'), build: () => env([[0, 0], [48, 56], [64, 48], [128, 0]], { sustain: true, sustainPoint: 2 }) },
  { name: msg('Piano'), build: () => env([[0, 64], [8, 44], [40, 32], [48, 0]], { sustain: true, sustainPoint: 2 }) },
  { name: msg('Tremolo'), build: () => env([[0, 64], [6, 24], [12, 64], [20, 0]], { loop: true, loopStart: 0, loopEnd: 2 }) },
  { name: msg('Gate'), build: () => env([[0, 64], [3, 0], [6, 64], [9, 0]], { loop: true, loopStart: 0, loopEnd: 3 }) },
];

export const PANNING_PRESETS: EnvelopePreset[] = [
  { name: msg('Centre'), build: () => env([[0, 32]]) },
  { name: msg('Left to right'), build: () => env([[0, 0], [96, 64]]) },
  { name: msg('Right to left'), build: () => env([[0, 64], [96, 0]]) },
  { name: msg('Ping-pong'), build: () => env([[0, 8], [24, 56], [48, 8]], { loop: true, loopStart: 0, loopEnd: 2 }) },
  { name: msg('Fast swirl'), build: () => env([[0, 16], [6, 48], [12, 16]], { loop: true, loopStart: 0, loopEnd: 2 }) },
];

export function cloneEnvelope(e: Envelope): Envelope {
  return { ...e, points: e.points.map((p) => ({ ...p })) };
}

/** Copied envelope; volume and panning share it, so either can be pasted into the other. */
let clipboard: Envelope | null = null;

export function copyEnvelope(e: Envelope): void {
  clipboard = cloneEnvelope(e);
}

export function pastedEnvelope(): Envelope | null {
  return clipboard ? cloneEnvelope(clipboard) : null;
}
