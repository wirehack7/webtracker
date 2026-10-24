import { noteFrequency, Player, ToneVoice } from '@webtracker/engine';
import type { EngineMessage, WorkletMessage } from './messages.ts';

/** Frames per scope snapshot, and snapshots per second. */
const SCOPE_FRAMES = 1024;
const SCOPE_RATE = 30;

class EngineProcessor extends AudioWorkletProcessor {
  private readonly voice = new ToneVoice(sampleRate);
  private player: Player | null = null;
  private scratch = new Float32Array(128);
  private songLeft = new Float32Array(128);
  private songRight = new Float32Array(128);
  private framesToScopes = 0;

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
        this.voice.noteOn(noteFrequency(message.note));
        return;
      case 'noteOff':
        this.voice.noteOff();
        return;
      case 'load': {
        const player = new Player(message.song, sampleRate);
        player.onRow = (state) => this.send({ type: 'row', state, levels: player.channelLevels() });
        player.enableScopes(SCOPE_FRAMES);
        this.player = player;
        break;
      }
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
    if (!output || !left) return true;
    const frames = left.length;
    const right = output[1] ?? left;
    if (right === left) {
      // Mono output: mix into a scratch buffer so the voice is not added twice.
      if (this.scratch.length !== frames) this.scratch = new Float32Array(frames);
      this.voice.mix(left, this.scratch, frames);
    } else {
      this.voice.mix(left, right, frames);
    }

    const player = this.player;
    if (player?.playing) {
      if (this.songLeft.length !== frames) {
        this.songLeft = new Float32Array(frames);
        this.songRight = new Float32Array(frames);
      }
      player.process(this.songLeft, this.songRight, frames);
      this.framesToScopes -= frames;
      if (this.framesToScopes <= 0) {
        this.framesToScopes += sampleRate / SCOPE_RATE;
        const channels = player.readScopes();
        this.port.postMessage({ type: 'scopes', channels } satisfies WorkletMessage, channels.map((c) => c.buffer as ArrayBuffer));
      }
      if (right === left) {
        for (let i = 0; i < frames; i++) left[i]! += (this.songLeft[i]! + this.songRight[i]!) * 0.5;
      } else {
        for (let i = 0; i < frames; i++) {
          left[i]! += this.songLeft[i]!;
          right[i]! += this.songRight[i]!;
        }
      }
    }
    return true;
  }
}

registerProcessor('webtracker-engine', EngineProcessor);
