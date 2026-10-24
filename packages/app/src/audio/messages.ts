import type { Instrument, Pattern, PlayerState, Song, VoiceState } from '@webtracker/engine';

/** Messages from the main thread to the engine worklet. */
export type EngineMessage =
  | { type: 'noteOn'; note: number; instrument: number }
  | { type: 'noteOff' }
  | { type: 'load'; song: Song }
  | { type: 'play'; loopPattern: boolean; order?: number }
  | { type: 'stop' }
  | { type: 'seek'; order: number }
  | { type: 'mute'; muted: boolean[] }
  | { type: 'mixer'; interpolation: boolean; volumeRamps: boolean }
  // Live edits to the song that is playing.
  | { type: 'pattern'; index: number; pattern: Pattern }
  | { type: 'instrument'; index: number; instrument: Instrument }
  | { type: 'orders'; orders: number[]; restartPosition: number }
  | { type: 'tempo'; speed: number; tempo: number };

/** Messages from the engine worklet to the main thread. */
export type WorkletMessage =
  | { type: 'row'; state: PlayerState; levels: number[] }
  | { type: 'state'; state: PlayerState }
  // Recent output of each channel, oldest frame first, for the scopes.
  | { type: 'scopes'; channels: Float32Array[] }
  // Sounding voices, for play markers in the sample and envelope editors.
  | { type: 'voices'; voices: VoiceState[] };
