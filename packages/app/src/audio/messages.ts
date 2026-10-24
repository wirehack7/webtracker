/** Messages from the main thread to the engine worklet. */
export type EngineMessage =
  | { type: 'noteOn'; note: number }
  | { type: 'noteOff' };
