import type { PlayerState, Song } from '@webtracker/engine';
import workletCode from 'virtual:replayer-worklet';
import { DEFAULT_MIXER } from './core.ts';
import type { MixerSettings, ReplayerEvent, ReplayerMessage } from './messages.ts';

export type { MixerSettings } from './messages.ts';
export type { PlayerState as Position, Song } from '@webtracker/engine';

export interface ReplayerOptions extends Partial<MixerSettings> {
  /** The audio context to play in; a new one is made when left out. */
  context?: AudioContext;
  /** Where the output goes; the context's speakers when left out. */
  destination?: AudioNode;
}

/** What a module can be given as: its bytes, a URL to fetch, or a song already loaded. */
export type Source = ArrayBuffer | Uint8Array | string | Song;

export type Parser = (buffer: ArrayBuffer, fileName: string) => Song;

let workletUrl: string | null = null;
const registered = new WeakSet<BaseAudioContext>();

async function register(context: BaseAudioContext): Promise<void> {
  if (registered.has(context)) return;
  workletUrl ??= URL.createObjectURL(new Blob([workletCode], { type: 'text/javascript' }));
  await context.audioWorklet.addModule(workletUrl);
  registered.add(context);
}

async function toSong(source: Source, parse: Parser): Promise<Song> {
  if (typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Could not load ${source}: ${response.status}`);
    return parse(await response.arrayBuffer(), new URL(source, location.href).pathname.split('/').pop() ?? '');
  }
  if (source instanceof ArrayBuffer) return parse(source, '');
  if (source instanceof Uint8Array) return parse(source.slice().buffer, '');
  return source;
}

/**
 * A module playing in an AudioWorklet. Row callbacks come when the row is
 * heard, not when it is rendered, so visuals can sync to them directly.
 */
export class Replayer {
  /** Called when a row starts sounding. */
  onRow: ((position: PlayerState) => void) | null = null;
  /** Called when the song ends; only with `loop: false`. */
  onEnd: (() => void) | null = null;

  private settings: MixerSettings;
  private last: { state: PlayerState; when: number; songTime: number } | null = null;
  private playing = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  private constructor(
    readonly song: Song,
    readonly context: AudioContext,
    readonly node: AudioWorkletNode,
    settings: MixerSettings,
  ) {
    this.settings = settings;
    node.port.onmessage = (event: MessageEvent<ReplayerEvent>) => this.receive(event.data);
  }

  static async create(source: Source, parse: Parser, options: ReplayerOptions = {}): Promise<Replayer> {
    const song = await toSong(source, parse);
    const context = options.context ?? new AudioContext();
    await register(context);
    const node = new AudioWorkletNode(context, 'webtracker-replayer', { numberOfInputs: 0, outputChannelCount: [2] });
    node.connect(options.destination ?? context.destination);
    const settings: MixerSettings = {
      loop: options.loop ?? DEFAULT_MIXER.loop,
      volume: options.volume ?? DEFAULT_MIXER.volume,
      resampler: options.resampler ?? DEFAULT_MIXER.resampler,
      stereoSeparation: options.stereoSeparation ?? DEFAULT_MIXER.stereoSeparation,
    };
    const replayer = new Replayer(song, context, node, settings);
    replayer.send({ type: 'song', song });
    replayer.send({ type: 'mixer', settings });
    return replayer;
  }

  private send(message: ReplayerMessage): void {
    this.node.port.postMessage(message);
  }

  /** The output latency, so callbacks fire when the sound reaches the speakers. */
  private get latency(): number {
    return (this.context.outputLatency || 0) + (this.context.baseLatency || 0);
  }

  private later(when: number, fn: () => void): void {
    const delay = Math.max(0, (when + this.latency - this.context.currentTime) * 1000);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delay);
    this.timers.add(timer);
  }

  private receive(event: ReplayerEvent): void {
    if (event.type === 'row') {
      this.later(event.when, () => {
        this.last = event;
        this.onRow?.(event.state);
      });
    } else {
      this.later(event.when, () => {
        this.playing = false;
        this.last = null;
        this.onEnd?.();
      });
    }
  }

  get title(): string {
    return this.song.title;
  }

  /** Starts or continues playing. Call it from a click or key press the first time, browsers block audio otherwise. */
  async play(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume();
    this.send({ type: 'play' });
    this.playing = true;
  }

  pause(): void {
    // Keep the time where it stopped, so `time` holds still while paused.
    if (this.last && this.playing) this.last = { ...this.last, songTime: this.time, when: this.context.currentTime - this.latency };
    this.send({ type: 'pause' });
    this.playing = false;
  }

  /** Stops and goes back to the start. */
  stop(): void {
    this.pause();
    this.seek(0);
  }

  /** Jumps to a position in the order list. */
  seek(order: number, row = 0): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.last = null;
    this.send({ type: 'seek', order, row });
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** The row heard now, or null before the first one. */
  get position(): PlayerState | null {
    return this.last?.state ?? null;
  }

  /** Seconds into the song as heard, counted from the start or the last seek. */
  get time(): number {
    const last = this.last;
    if (!last) return 0;
    if (!this.playing) return last.songTime;
    return Math.max(last.songTime, last.songTime + this.context.currentTime - this.latency - last.when);
  }

  get volume(): number {
    return this.settings.volume;
  }

  set volume(value: number) {
    this.set({ volume: value });
  }

  get loop(): boolean {
    return this.settings.loop;
  }

  set loop(value: boolean) {
    this.set({ loop: value });
  }

  /** Changes several mixer settings at once. */
  set(settings: Partial<MixerSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.send({ type: 'mixer', settings: this.settings });
  }

  /** Stops and lets go of the audio node; the context stays open. */
  destroy(): void {
    this.seek(0);
    this.send({ type: 'pause' });
    this.node.disconnect();
    this.node.port.onmessage = null;
    this.playing = false;
  }
}
