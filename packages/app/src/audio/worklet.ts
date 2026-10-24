import { noteFrequency, ToneVoice } from '@webtracker/engine';
import type { EngineMessage } from './messages.ts';

class EngineProcessor extends AudioWorkletProcessor {
  private readonly voice = new ToneVoice(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<EngineMessage>) => {
      const message = event.data;
      if (message.type === 'noteOn') this.voice.noteOn(noteFrequency(message.note));
      else this.voice.noteOff();
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output?.[0];
    if (!output || !left) return true;
    const right = output[1] ?? left;
    if (right === left) {
      // Mono output: mix into a scratch buffer so the voice is not added twice.
      this.voice.mix(left, new Float32Array(left.length), left.length);
    } else {
      this.voice.mix(left, right, left.length);
    }
    return true;
  }
}

registerProcessor('webtracker-engine', EngineProcessor);
