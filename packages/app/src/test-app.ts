/**
 * Boots the whole tracker (main.ts) on the real index.html under happy-dom,
 * with stand-ins for what happy-dom lacks: audio, workers, downloads, the
 * clipboard, pop-ups and animation frames. Each boot gets fresh modules,
 * an empty IndexedDB and empty local storage, so tests do not share state.
 */
import { IDBFactory } from 'fake-indexeddb';
import { loadModule } from '@webtracker/formats';
import type { Song } from '@webtracker/engine';
import { vi } from 'vitest';
import type { EngineMessage, WorkletMessage } from './audio/messages.ts';
import { latestRelease, SEEN_KEY } from './ui/changelog.ts';
import { installDom, loadPage } from './test-dom.ts';

export interface Download {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** A worker that answers the way a test tells it to. */
export class FakeWorker {
  static all: FakeWorker[] = [];
  /** Replies for the next workers, one list each; 'crash' fires onerror. */
  static script: (unknown | 'crash')[][] = [];
  requests: unknown[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor(readonly url: URL) {
    FakeWorker.all.push(this);
  }
  postMessage(request: unknown) {
    this.requests.push(request);
    const replies = FakeWorker.script.shift() ?? [];
    queueMicrotask(() => {
      for (const reply of replies) {
        if (reply === 'crash') this.onerror?.(Object.assign(new Event('error'), { message: 'worker crashed' }) as ErrorEvent);
        else this.onmessage?.({ data: reply } as MessageEvent);
      }
    });
  }
  /** Sends a reply later, for workers whose script was left empty. */
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  terminate() {
    this.terminated = true;
  }
}

class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}

/** Enough of an AudioContext for the engine node and the sample library's audition. */
class FakeAudioContext extends EventTarget {
  static last: FakeAudioContext | null = null;
  static fail = false;
  readonly sampleRate = 48000;
  readonly destination = {};
  currentTime = 0;
  state = 'running';
  sources: { buffer: { rate: number; length: number }; loop: boolean; started: boolean; stopped: boolean }[] = [];
  readonly audioWorklet = {
    addModule: async () => {
      if (FakeAudioContext.fail) throw new Error('no worklet');
    },
  };
  constructor() {
    super();
    FakeAudioContext.last = this;
  }
  async resume() {}
  createBuffer(_channels: number, length: number, rate: number) {
    return { rate, length, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const source = { buffer: null as never, loop: false, loopStart: 0, loopEnd: 0, started: false, stopped: false };
    this.sources.push(source);
    return Object.assign(source, {
      connect: (node: unknown) => node,
      start: () => (source.started = true),
      stop: () => (source.stopped = true),
    });
  }
  createGain() {
    return { gain: new FakeParam(), connect: (node: unknown) => node };
  }
}

export interface App {
  /** Messages the page sent to the engine worklet. */
  messages: EngineMessage[];
  downloads: Download[];
  opened: { url: string; tab: { location: { href: string }; close(): void; closed: boolean } | null }[];
  clipboard: string[];
  $<T extends HTMLElement = HTMLElement>(selector: string): T;
  status(): string;
  click(selector: string, init?: MouseEventInit): void;
  /** A key press on the page, with KeyboardEvent codes such as 'KeyQ'. */
  key(code: string, init?: KeyboardEventInit): void;
  /** Only the keydown or keyup half of a press. */
  keyEvent(type: 'keydown' | 'keyup', code: string, init?: KeyboardEventInit): void;
  /** Sends a message from the worklet to the page. */
  worklet(message: WorkletMessage): void;
  /** The open dialog, if any. */
  dialog(): HTMLDialogElement | null;
  /** Presses a button in the in-page question that is open. */
  answer(button: string, text?: string): Promise<void>;
  /** Lets promises, IndexedDB and timers of 0 ms run. */
  settle(ms?: number): Promise<void>;
  /** Runs the animation frames that are due. */
  frame(): void;
  /** Saves the song as XM through the Save dialog's button and loads it back. */
  song(): Song;
  /** Picks a file in a file input. */
  pick(selector: string, file: File): Promise<void>;
  /** Text of a pattern cell. */
  cell(row: number, channel: number): string;
  /** Row and channel of the pattern cursor. */
  cursor(): [number, number];
}

let listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];

/** Removes what the last boot added to window and document, so only one tracker listens. */
export function shutdownApp(): void {
  for (const [target, type, listener, options] of listeners) target.removeEventListener(type, listener, options);
  listeners = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
}

export interface BootOptions {
  hash?: string;
  storage?: Record<string, string>;
  /** IndexedDB to use, e.g. one a test filled before the boot. */
  indexedDB?: IDBFactory;
  /** Runs after the stand-ins are in place and before main.ts runs. */
  before?: () => void | Promise<void>;
}

export async function bootApp(options: BootOptions = {}): Promise<App> {
  shutdownApp();
  vi.resetModules();
  installDom();
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, opts) => {
      listeners.push([target, type, listener!, opts]);
      add(type, listener, opts);
    });
  }

  localStorage.clear();
  // Stored data makes the page a returning visitor's, who would get What's new after an update.
  if (options.storage) localStorage.setItem(SEEN_KEY, latestRelease());
  for (const [key, value] of Object.entries(options.storage ?? {})) localStorage.setItem(key, value);
  vi.stubGlobal('indexedDB', options.indexedDB ?? new IDBFactory());
  history.replaceState(null, '', `/${options.hash ?? ''}`);

  const messages: EngineMessage[] = [];
  let node: { port: { onmessage: ((event: { data: WorkletMessage }) => void) | null } } | null = null;
  FakeAudioContext.last = null;
  FakeAudioContext.fail = false;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = { onmessage: null, postMessage: (m: EngineMessage) => messages.push(m) };
      constructor() {
        node = this;
      }
      connect() {}
    },
  );
  FakeWorker.all = [];
  FakeWorker.script = [];
  vi.stubGlobal('Worker', FakeWorker);

  const downloads: Download[] = [];
  const blobs = new Map<string, Blob>();
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (!blob) return;
    downloads.push({ name: this.download, type: blob.type, bytes: blobBytes.get(blob) ?? new Uint8Array() });
  });

  const opened: App['opened'] = [];
  vi.stubGlobal('open', (url: string) => {
    const tab = { location: { href: url }, closed: false, close: () => (tab.closed = true) };
    opened.push({ url, tab });
    return tab;
  });
  const clipboard: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void clipboard.push(text) } });
  vi.spyOn(location, 'reload').mockImplementation(() => {});

  let frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: () => Promise.resolve([]), ready: Promise.resolve() } });
  Element.prototype.scrollIntoView = () => {};

  await loadPage('index.html');
  await options.before?.();
  await import('./main.ts');

  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`No ${selector}`);
    return element;
  };
  const settle = async (ms = 0) => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, ms / 5));
  };
  const app: App = {
    messages,
    downloads,
    opened,
    clipboard,
    $,
    status: () => $('#status').textContent ?? '',
    click(selector, init) {
      $(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    },
    key(code, init = {}) {
      app.keyEvent('keydown', code, init);
      app.keyEvent('keyup', code, init);
    },
    keyEvent(type, code, init = {}) {
      const key = init.key ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code);
      const focused = document.activeElement as HTMLElement | null;
      const target = focused?.isConnected ? focused : document.body;
      target.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true, ...init }));
    },
    worklet(message) {
      node?.port.onmessage?.({ data: message });
    },
    dialog: () => document.querySelector<HTMLDialogElement>('dialog[open]'),
    async answer(button, text) {
      const dialog = await vi.waitFor(() => {
        const open = [...document.querySelectorAll<HTMLDialogElement>('dialog.ask[open], dialog[open]')].at(-1);
        if (!open) throw new Error('No dialog open');
        return open;
      });
      if (text !== undefined) dialog.querySelector('input')!.value = text;
      const press = [...dialog.querySelectorAll('button')].find((b) => b.textContent === button);
      if (!press) throw new Error(`No ${button} button in ${dialog.textContent}`);
      press.click();
      await settle();
    },
    settle,
    frame() {
      const due = frames;
      frames = [];
      for (const callback of due) callback(0);
    },
    song() {
      const before = downloads.length;
      app.click('#save-xm');
      const blob = [...blobs.values()].at(-1)!;
      expectDownload(downloads.length > before);
      return loadModuleSync(blob);
    },
    async pick(selector, file) {
      const input = $<HTMLInputElement>(selector);
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new Event('change'));
      Object.defineProperty(input, 'files', { configurable: true, value: [] });
      await settle(10);
    },
    cursor() {
      const at = $('#pattern .c.at');
      return [Number(at.closest<HTMLElement>('.r')!.dataset.row), Number(at.dataset.channel)];
    },
    cell(row, channel) {
      return $(`#pattern .r[data-row="${row}"] .c[data-channel="${channel}"]`).textContent ?? '';
    },
  };
  // The page reads the last session from IndexedDB as it starts.
  await settle(10);
  return app;
}

function expectDownload(made: boolean): void {
  if (!made) throw new Error('Nothing was downloaded');
}

/** The bytes of a Blob made from one Uint8Array, read synchronously through the stand-in. */
const blobBytes = new WeakMap<Blob, Uint8Array>();
const RealBlob = Blob;
// Downloads keep their bytes so tests can read them without waiting.
globalThis.Blob = class extends RealBlob {
  constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    const [part] = parts ?? [];
    if (parts?.length === 1 && part instanceof Uint8Array) blobBytes.set(this, part);
  }
} as typeof Blob;

function loadModuleSync(blob: Blob): Song {
  const bytes = blobBytes.get(blob);
  if (!bytes) throw new Error('The download was not made from bytes');
  return loadModule(bytes.slice().buffer, 'saved.xm');
}

export const fakeAudio = FakeAudioContext;
