import workletUrl from './worklet.ts?worker&url';
import type { EngineMessage, WorkletMessage } from './messages.ts';

/**
 * iOS mutes web pages with the ring/silent switch unless they say they play media
 * (Safari 17 and later); a tracker is no use muted, so it asks to play like a music app.
 */
function playThroughSilentMode(): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session?.type === 'auto') session.type = 'playback';
}

/**
 * Phones suspend or interrupt audio when the browser goes to the background, and iOS
 * keeps a new context suspended until a gesture it accepts: the end of a tap, a click or
 * a key, not the start of a touch. Resume on return, or on the next such gesture.
 */
function keepRunning(context: AudioContext): void {
  const wake = () => {
    if (document.visibilityState === 'visible' && context.state !== 'running' && context.state !== 'closed') {
      void context.resume().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', wake);
  context.addEventListener('statechange', wake);
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
}

/** Main-thread handle to the engine running in the AudioWorklet. */
export class EngineNode {
  /** Called for every message the worklet sends (row changes, state updates). */
  onMessage: ((message: WorkletMessage) => void) | null = null;

  private constructor(
    readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
  ) {
    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.onMessage?.(event.data);
  }

  /** Must be called from a user gesture, browsers block audio otherwise. */
  static async start(): Promise<EngineNode> {
    playThroughSilentMode();
    const context = new AudioContext({ latencyHint: 'interactive' });
    // Asked for at once, while the gesture still counts; later awaits would lose it on iOS.
    const resumed = context.resume().catch(() => {});
    keepRunning(context);
    // Loading the worklet while the resume is under way can freeze the page for good in WebKit,
    // so wait for it first. iOS starts audio only when a tap ends, which keepRunning catches,
    // so a pending resume does not hold up the editor.
    await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, 500))]);
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, 'webtracker-engine', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    });
    node.connect(context.destination);
    return new EngineNode(context, node);
  }

  send(message: EngineMessage): void {
    this.node.port.postMessage(message);
  }
}
