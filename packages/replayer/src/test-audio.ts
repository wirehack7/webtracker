/**
 * Just enough Web Audio to run the replayer in Node: an AudioContext with a
 * clock the test moves, and AudioWorkletNodes that run the real worklet
 * processor (worklet.ts) in-process, with message ports wired back to back.
 */

type Listener = ((event: MessageEvent) => void) | null;

class FakePort {
  onmessage: Listener = null;
  peer: FakePort | null = null;
  /** Messages with transferables are passed by reference, the rest too; tests do not mutate them. */
  postMessage(data: unknown): void {
    this.peer?.onmessage?.({ data } as MessageEvent);
  }
}

function portPair(): [FakePort, FakePort] {
  const a = new FakePort();
  const b = new FakePort();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorClass = new () => Processor;

const processors = new Map<string, ProcessorClass>();
/** The port the next processor takes, set while AudioWorkletNode constructs it. */
let nextPort: FakePort | null = null;

const scope = globalThis as Record<string, unknown>;
scope.sampleRate = 44100;
scope.currentTime = 0;
scope.registerProcessor = (name: string, cls: ProcessorClass) => processors.set(name, cls);
scope.AudioWorkletProcessor = class {
  port = nextPort ?? new FakePort();
};

const WORKLET = './worklet.ts';
// The worklet registers its processor when loaded; the specifier is a variable so
// the type checker leaves the worklet to its own project with the AudioWorklet types.
await import(/* @vite-ignore */ WORKLET);

export class FakeAudioWorkletNode {
  readonly port: FakePort;
  readonly processor: Processor;
  connectedTo: unknown = null;

  constructor(
    readonly context: FakeAudioContext,
    name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    const cls = processors.get(name);
    if (!cls) throw new Error(`No processor called ${name}`);
    const [page, worklet] = portPair();
    this.port = page;
    nextPort = worklet;
    this.processor = new cls();
    nextPort = null;
    context.nodes.push(this);
  }

  connect(destination: unknown): void {
    this.connectedTo = destination;
  }

  disconnect(): void {
    this.connectedTo = null;
    this.context.nodes.splice(this.context.nodes.indexOf(this), 1);
  }
}

export class FakeAudioContext {
  readonly sampleRate = 44100;
  readonly destination = { name: 'speakers' };
  readonly outputLatency = 0.02;
  readonly baseLatency = 0.01;
  currentTime = 0;
  state: 'suspended' | 'running' = 'suspended';
  nodes: FakeAudioWorkletNode[] = [];
  readonly modules: string[] = [];
  readonly audioWorklet = {
    addModule: async (url: string) => {
      this.modules.push(url);
    },
  };

  async resume(): Promise<void> {
    this.state = 'running';
  }

  /**
   * Runs every node for `seconds` in blocks of 128 frames, as the audio thread
   * would, and returns the first node's output. `mono` gives it one channel.
   * `afterBlock` runs after each block, to keep other clocks in step.
   */
  render(seconds: number, mono = false, afterBlock?: (seconds: number) => void): { left: Float32Array; right: Float32Array } {
    const blocks = Math.ceil((seconds * this.sampleRate) / 128);
    const left = new Float32Array(blocks * 128);
    const right = new Float32Array(blocks * 128);
    for (let b = 0; b < blocks; b++) {
      scope.currentTime = this.currentTime;
      this.nodes.forEach((node, n) => {
        const out = [new Float32Array(128), new Float32Array(128)];
        node.processor.process([], [mono ? [out[0]!] : out]);
        if (n === 0) {
          left.set(out[0]!, b * 128);
          right.set(mono ? out[0]! : out[1]!, b * 128);
        }
      });
      this.currentTime += 128 / this.sampleRate;
      afterBlock?.(128 / this.sampleRate);
    }
    return { left, right };
  }
}

export const peak = (signal: Float32Array) => signal.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
