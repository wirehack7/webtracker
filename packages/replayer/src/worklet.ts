import { ReplayerCore } from './core.ts';
import type { ReplayerMessage } from './messages.ts';

class ReplayerProcessor extends AudioWorkletProcessor {
  private readonly core = new ReplayerCore(sampleRate, (event) =>
    this.port.postMessage(event, event.type === 'scopes' ? event.channels.map((c) => c.buffer as ArrayBuffer) : []),
  );
  private spare = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<ReplayerMessage>) => this.core.handle(event.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const left = outputs[0]?.[0];
    if (!left) return true;
    let right = outputs[0]?.[1];
    if (!right) {
      if (this.spare.length !== left.length) this.spare = new Float32Array(left.length);
      right = this.spare;
    }
    this.core.process(left, right, left.length, currentTime);
    if (right === this.spare) for (let i = 0; i < left.length; i++) left[i] = (left[i]! + right[i]!) * 0.5;
    return true;
  }
}

registerProcessor('webtracker-replayer', ReplayerProcessor);
