import workletUrl from './worklet.ts?worker&url';
import type { EngineMessage, WorkletMessage } from './messages.ts';

/** Main-thread handle to the engine running in the AudioWorklet. */
export class EngineNode {
  /** Called for every message the worklet sends (row changes, state updates). */
  onMessage: ((message: WorkletMessage) => void) | null = null;

  private constructor(
    readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
  ) {
    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.onMessage?.(event.data);
    // Phones suspend or interrupt audio when the browser goes to the background.
    // Resume on return, or on the next tap where the browser wants a gesture.
    const wake = () => {
      if (document.visibilityState === 'visible' && context.state !== 'running' && context.state !== 'closed') {
        void context.resume().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', wake);
    context.addEventListener('statechange', wake);
    for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, wake, { capture: true });
  }

  /** Must be called from a user gesture, browsers block audio otherwise. */
  static async start(): Promise<EngineNode> {
    const context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, 'webtracker-engine', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    node.connect(context.destination);
    await context.resume();
    return new EngineNode(context, node);
  }

  send(message: EngineMessage): void {
    this.node.port.postMessage(message);
  }
}
