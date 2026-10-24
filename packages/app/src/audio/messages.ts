import type { PlayerState, Song } from '@webtracker/engine';

/** Messages from the main thread to the engine worklet. */
export type EngineMessage =
  | { type: 'noteOn'; note: number }
  | { type: 'noteOff' }
  | { type: 'load'; song: Song }
  | { type: 'play'; loopPattern: boolean }
  | { type: 'stop' }
  | { type: 'seek'; order: number };

/** Messages from the engine worklet to the main thread. */
export type WorkletMessage =
  | { type: 'row'; state: PlayerState; levels: number[] }
  | { type: 'state'; state: PlayerState };
