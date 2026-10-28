// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineNode } from './engine.ts';
import type { WorkletMessage } from './messages.ts';

/**
 * Starting audio on the main thread. The context and node are stand-ins that
 * record what the tracker asks of them; the worklet itself has its own test.
 */

class FakeGain {
  connectedTo: unknown = null;
  calls: string[] = [];
  readonly gain = {
    value: 1,
    cancelScheduledValues: (time: number) => this.calls.push(`cancel ${time}`),
    setValueAtTime: (value: number, time: number) => this.calls.push(`set ${value} ${time}`),
    setTargetAtTime: (value: number, time: number) => this.calls.push(`glide ${value} ${time}`),
  };
  connect(destination: unknown) {
    this.connectedTo = destination;
  }
}

class FakeContext extends EventTarget {
  static last: FakeContext;
  state: AudioContextState = 'suspended';
  readonly destination = { name: 'speakers' };
  modules: string[] = [];
  resumes = 0;
  /** What resume() does: resolve, fail, or never settle. */
  static resume: 'ok' | 'fail' | 'hang' = 'ok';
  readonly audioWorklet = { addModule: async (url: string) => void this.modules.push(url) };
  currentTime = 2;
  readonly gain = new FakeGain();
  createGain() {
    return this.gain;
  }

  constructor(readonly options: AudioContextOptions) {
    super();
    FakeContext.last = this;
  }

  resume(): Promise<void> {
    this.resumes++;
    if (FakeContext.resume === 'fail') return Promise.reject(new Error('not allowed'));
    if (FakeContext.resume === 'hang') return new Promise(() => {});
    this.state = 'running';
    return Promise.resolve();
  }
}

class FakeNode {
  static last: FakeNode;
  readonly port = { onmessage: null as ((event: { data: WorkletMessage }) => void) | null, postMessage: vi.fn() };
  connectedTo: unknown = null;
  constructor(
    readonly context: FakeContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    FakeNode.last = this;
  }
  connect(destination: unknown) {
    this.connectedTo = destination;
  }
}

let listeners: { type: string; listener: EventListener }[];

beforeEach(() => {
  FakeContext.resume = 'ok';
  listeners = [];
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    listeners.push({ type, listener: listener as EventListener });
    add(type, listener, options);
  });
});

afterEach(() => {
  for (const { type, listener } of listeners) window.removeEventListener(type, listener, { capture: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EngineNode', () => {
  it('starts an interactive context, loads the worklet and connects it to the speakers through the master volume', async () => {
    const engine = await EngineNode.start();
    const context = FakeContext.last;
    expect(engine.context).toBe(context);
    expect(context.options).toEqual({ latencyHint: 'interactive' });
    expect(context.modules).toHaveLength(1);
    expect(FakeNode.last.name).toBe('webtracker-engine');
    expect(FakeNode.last.options).toEqual({ numberOfInputs: 0, outputChannelCount: [2] });
    expect(FakeNode.last.connectedTo).toBe(context.gain);
    expect(engine.output).toBe(context.gain);
    expect(context.gain.connectedTo).toBe(context.destination);
    expect(context.gain.gain.value).toBe(1);
  });

  it('starts at the stored master volume and glides to a new one', async () => {
    const engine = await EngineNode.start(0.25);
    const gain = FakeContext.last.gain;
    expect(gain.gain.value).toBe(0.25);
    engine.setGain(0.5);
    expect(gain.calls).toEqual(['cancel 2', 'set 0.25 2', 'glide 0.5 2']);
  });

  it('passes messages both ways', async () => {
    const engine = await EngineNode.start();
    engine.send({ type: 'stop' });
    expect(FakeNode.last.port.postMessage).toHaveBeenCalledWith({ type: 'stop' });
    const got: WorkletMessage[] = [];
    FakeNode.last.port.onmessage!({ data: { type: 'voices', voices: [] } });
    engine.onMessage = (m) => got.push(m);
    FakeNode.last.port.onmessage!({ data: { type: 'voices', voices: [] } });
    expect(got).toEqual([{ type: 'voices', voices: [] }]);
  });

  it('asks iOS to play through the silent switch, unless the page chose otherwise', async () => {
    const audioSession = { type: 'auto' };
    vi.stubGlobal('navigator', { audioSession });
    await EngineNode.start();
    expect(audioSession.type).toBe('playback');
    audioSession.type = 'ambient';
    await EngineNode.start();
    expect(audioSession.type).toBe('ambient');
  });

  it('goes on after half a second when the resume waits for a tap, and a failed resume is no error', async () => {
    vi.useFakeTimers();
    FakeContext.resume = 'hang';
    const started = EngineNode.start();
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeContext.last.modules).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(started).resolves.toBeInstanceOf(EngineNode);
    vi.useRealTimers();
    FakeContext.resume = 'fail';
    await expect(EngineNode.start()).resolves.toBeInstanceOf(EngineNode);
  });

  it('resumes on the next gesture, on return to the page and when the browser interrupts it', async () => {
    FakeContext.resume = 'hang';
    vi.useFakeTimers();
    const started = EngineNode.start();
    await vi.advanceTimersByTimeAsync(500);
    await started;
    const context = FakeContext.last;
    expect(context.resumes).toBe(1);
    FakeContext.resume = 'ok';
    window.dispatchEvent(new Event('pointerup'));
    expect(context.resumes).toBe(2);
    // Running: nothing to do.
    window.dispatchEvent(new Event('keydown'));
    expect(context.resumes).toBe(2);
    context.state = 'interrupted' as AudioContextState;
    context.dispatchEvent(new Event('statechange'));
    expect(context.resumes).toBe(3);
    // Not while hidden, and never once closed.
    context.state = 'suspended';
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(context.resumes).toBe(3);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(context.resumes).toBe(4);
    context.state = 'closed';
    window.dispatchEvent(new Event('click'));
    expect(context.resumes).toBe(4);
    // A refused resume is caught.
    context.state = 'suspended';
    FakeContext.resume = 'fail';
    window.dispatchEvent(new Event('touchend'));
    expect(context.resumes).toBe(5);
  });
});
