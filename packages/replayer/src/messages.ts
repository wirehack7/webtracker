import type { PlayerState, Resampler, Song } from '@webtracker/engine';

export interface MixerSettings {
  /** Play the song again from its restart position when it ends. */
  loop: boolean;
  /** Output volume, 1 is the tracker's own level. */
  volume: number;
  resampler: Resampler;
  /** Stereo width in percent: 0 is mono, 100 the song's panning. */
  stereoSeparation: number;
}

/** Messages from the page to the worklet. */
export type ReplayerMessage =
  | { type: 'song'; song: Song }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; order: number; row: number }
  | { type: 'mixer'; settings: MixerSettings };

/** Messages from the worklet to the page. */
export type ReplayerEvent =
  // `when` is the audio clock time the row starts at, `songTime` how far into the song it is.
  | { type: 'row'; state: PlayerState; when: number; songTime: number }
  | { type: 'end'; when: number };
