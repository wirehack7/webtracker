import { Player } from '@webtracker/engine';
import type { EngineMessage, WorkletMessage } from './messages.ts';

/** Frames per scope snapshot, and snapshots per second. */
const SCOPE_FRAMES = 1024;
const SCOPE_RATE = 30;

class EngineProcessor extends AudioWorkletProcessor {
  private player: Player | null = null;
  private songLeft = new Float32Array(128);
  private songRight = new Float32Array(128);
  private framesToScopes = 0;
  /** Kept here so a reloaded song keeps the muted channels. */
  private muted: boolean[] = [];

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<EngineMessage>) => this.handle(event.data);
  }

  private send(message: WorkletMessage): void {
    this.port.postMessage(message);
  }

  private handle(message: EngineMessage): void {
    switch (message.type) {
      case 'noteOn':
        this.player?.previewNote(message.instrument, message.note);
        return;
      case 'noteOff':
        this.player?.previewOff();
        return;
      case 'load': {
        const player = new Player(message.song, sampleRate);
        player.onRow = (state) => this.send({ type: 'row', state, levels: player.channelLevels() });
        player.enableScopes(SCOPE_FRAMES);
        player.muted = this.muted;
        this.player = player;
        break;
      }
      case 'mute':
        this.muted = [...message.muted];
        if (this.player) this.player.muted = this.muted;
        break;
      case 'play':
        if (this.player) {
          if (message.order !== undefined) this.player.reset(message.order);
          this.player.loopPattern = message.loopPattern;
          this.player.playing = true;
        }
        break;
      case 'stop':
        if (this.player) {
          // Stop keeps the position so play continues from there, like FT2.
          this.player.playing = false;
        }
        break;
      case 'seek':
        this.player?.reset(message.order);
        break;
      case 'pattern':
        if (this.player) this.player.song.patterns[message.index] = message.pattern;
        return;
      case 'instrument':
        if (this.player) this.player.song.instruments[message.index] = message.instrument;
        return;
      case 'orders':
        if (this.player) {
          const song = this.player.song;
          song.orders = message.orders;
          song.restartPosition = message.restartPosition;
          if (this.player.order >= song.orders.length) this.player.order = 0;
        }
        return;
      case 'tempo':
        if (this.player) {
          const song = this.player.song;
          song.initialSpeed = message.speed;
          song.initialTempo = message.tempo;
          // Like FT2, a change while playing takes effect right away.
          this.player.speed = message.speed;
          this.player.tempo = message.tempo;
        }
        return;
    }
    if (this.player) this.send({ type: 'state', state: this.player.getState() });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output?.[0];
    const player = this.player;
    if (!output || !left || !player) return true;
    const frames = left.length;
    const right = output[1];
    if (right) {
      player.process(left, right, frames);
    } else {
      // Mono output: render stereo and fold it down.
      if (this.songLeft.length !== frames) {
        this.songLeft = new Float32Array(frames);
        this.songRight = new Float32Array(frames);
      }
      player.process(this.songLeft, this.songRight, frames);
      for (let i = 0; i < frames; i++) left[i] = (this.songLeft[i]! + this.songRight[i]!) * 0.5;
    }
    if (player.playing) {
      this.framesToScopes -= frames;
      if (this.framesToScopes <= 0) {
        this.framesToScopes += sampleRate / SCOPE_RATE;
        const channels = player.readScopes();
        this.port.postMessage({ type: 'scopes', channels } satisfies WorkletMessage, channels.map((c) => c.buffer as ArrayBuffer));
      }
    }
    return true;
  }
}

registerProcessor('webtracker-engine', EngineProcessor);
