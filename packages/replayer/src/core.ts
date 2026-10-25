import { Player } from '@webtracker/engine';
import type { MixerSettings, ReplayerEvent, ReplayerMessage } from './messages.ts';

export const DEFAULT_MIXER: MixerSettings = { loop: true, volume: 1, resampler: 'auto', stereoSeparation: 100 };

/**
 * The replayer's audio side without the AudioWorklet around it: takes the
 * page's messages, renders blocks and reports rows and the song's end.
 */
export class ReplayerCore {
  private player: Player | null = null;
  private mixer: MixerSettings = { ...DEFAULT_MIXER };
  /** Frames rendered while playing, for the song time. */
  private frames = 0;
  /** Audio clock time of the block being rendered. */
  private now = 0;
  private ended = false;
  private scopeFrames = 0;
  private scopeRate = 0;
  /** Frames left until the next scope snapshot. */
  private framesToScopes = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly emit: (event: ReplayerEvent) => void,
  ) {}

  handle(message: ReplayerMessage): void {
    switch (message.type) {
      case 'song': {
        const player = new Player(message.song, this.sampleRate);
        player.onRow = (state) => {
          if (player.loops > 0 && !this.mixer.loop) {
            // Silence at once; the rewind waits until the row is done (see process).
            player.playing = false;
            this.ended = true;
            return;
          }
          this.emit({ type: 'row', state, when: this.now, songTime: this.frames / this.sampleRate });
        };
        this.player = player;
        this.frames = 0;
        this.ended = false;
        if (this.scopeRate > 0) player.enableScopes(this.scopeFrames);
        this.applyMixer();
        break;
      }
      case 'play':
        if (this.player) this.player.playing = true;
        break;
      case 'pause':
        if (this.player) this.player.playing = false;
        break;
      case 'seek':
        if (this.player) {
          const playing = this.player.playing;
          this.player.reset(message.order, message.row);
          this.player.playing = playing;
          // The time is not known after a jump; count from the start of the order list.
          this.frames = 0;
        }
        break;
      case 'mixer':
        this.mixer = { ...message.settings };
        this.applyMixer();
        break;
      case 'scopes':
        this.scopeFrames = Math.max(0, Math.floor(message.frames));
        this.scopeRate = this.scopeFrames > 0 ? Math.max(0, message.rate) : 0;
        this.framesToScopes = 0;
        this.player?.enableScopes(this.scopeRate > 0 ? this.scopeFrames : 0);
        break;
    }
  }

  private applyMixer(): void {
    const p = this.player;
    if (!p) return;
    p.amplify = Math.max(0, this.mixer.volume) * 100;
    p.resampler = this.mixer.resampler;
    p.stereoSeparation = this.mixer.stereoSeparation;
  }

  /** Renders `frames` stereo frames; `now` is the audio clock time of the first one. */
  process(left: Float32Array, right: Float32Array, frames: number, now: number): void {
    this.now = now;
    const p = this.player;
    if (!p) {
      left.fill(0, 0, frames);
      right.fill(0, 0, frames);
      return;
    }
    const playing = p.playing;
    p.process(left, right, frames);
    if (playing) this.frames += frames;
    if (this.scopeRate > 0 && playing) {
      this.framesToScopes -= frames;
      if (this.framesToScopes <= 0) {
        this.framesToScopes += this.sampleRate / this.scopeRate;
        // The snapshot ends with this block, so it is heard at the block's end.
        this.emit({ type: 'scopes', channels: p.readScopes(), when: now + frames / this.sampleRate });
      }
    }
    if (this.ended) {
      this.ended = false;
      p.reset();
      this.frames = 0;
      this.emit({ type: 'end', when: now });
    }
  }
}
