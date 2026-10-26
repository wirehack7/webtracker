/**
 * Links for jams: WebRTC data channels between browsers, and a
 * BroadcastChannel between tabs of one browser.
 *
 * WebRTC needs the two browsers to swap a short description of themselves
 * once. Without a server for that, people swap it themselves: the host's
 * invite link carries the offer, and the guest sends back an answer code.
 * A public STUN server tells each browser its address as seen from the
 * internet; it sees no song data, which goes straight from browser to browser.
 */

import { t } from '../i18n/i18n.ts';
import { fromBase64Url, pipe, toBase64Url } from '../storage/share.ts';
import type { Link } from './session.ts';

/** `#jam=…` in the address joins the jam the offer belongs to. */
export const JAM_PARAM = 'jam';
/** `#jam-tab=…` joins a jam in another tab of this browser. */
export const JAM_TAB_PARAM = 'jam-tab';
/** `#transfer=…` receives the songs and settings another browser sends. */
export const TRANSFER_PARAM = 'transfer';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
/** Gathering addresses rarely takes long; past this the ones found so far have to do. */
const GATHER_TIMEOUT = 5000;
/** Data channels split messages into pieces this big, which every browser takes. */
const PIECE = 16 * 1024;
const HIGH_WATER = 1024 * 1024;

/** The jam part of an address fragment, if any. */
export function jamFromHash(hash: string): { kind: 'rtc' | 'tab'; value: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const rtc = params.get(JAM_PARAM);
  if (rtc) return { kind: 'rtc', value: rtc };
  const tab = params.get(JAM_TAB_PARAM);
  return tab ? { kind: 'tab', value: tab } : null;
}

/** The offer of a transfer link in an address fragment, if any. */
export function transferFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get(TRANSFER_PARAM) || null;
}

async function packDescription(description: RTCSessionDescriptionInit): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ type: description.type, sdp: description.sdp }));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

async function unpackDescription(text: string, type: RTCSdpType, wrongOffer?: string): Promise<RTCSessionDescriptionInit> {
  let parsed: { type?: string; sdp?: string };
  try {
    const json = await pipe(fromBase64Url(text.trim()), new DecompressionStream('deflate-raw'));
    parsed = JSON.parse(new TextDecoder().decode(json)) as typeof parsed;
  } catch {
    throw new Error(t('This code is incomplete or broken'));
  }
  if (parsed.type !== type || typeof parsed.sdp !== 'string') {
    throw new Error(type === 'answer' ? t('This is not an answer code') : (wrongOffer ?? t('This is not a jam invite')));
  }
  return { type, sdp: parsed.sdp };
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, GATHER_TIMEOUT);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Wraps an open data channel: splits big messages and waits when the send buffer is full. */
class ChannelLink implements Link {
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  private queue: Uint8Array[] = [];
  private parts: Uint8Array[] = [];

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly channel: RTCDataChannel,
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
    channel.addEventListener('bufferedamountlow', () => this.pump());
    channel.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => this.receive(new Uint8Array(event.data)));
    channel.addEventListener('close', () => this.onClose?.());
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.onClose?.();
    });
  }

  send(bytes: Uint8Array): void {
    // Each piece starts with 1 on the last piece of a message, 0 on the others.
    let at = 0;
    do {
      const end = Math.min(bytes.length, at + PIECE);
      const piece = new Uint8Array(1 + end - at);
      piece[0] = end === bytes.length ? 1 : 0;
      piece.set(bytes.subarray(at, end), 1);
      this.queue.push(piece);
      at = end;
    } while (at < bytes.length);
    this.pump();
  }

  private pump(): void {
    while (this.queue.length && this.channel.readyState === 'open' && this.channel.bufferedAmount < HIGH_WATER) {
      this.channel.send(this.queue.shift() as Uint8Array<ArrayBuffer>);
    }
  }

  private receive(piece: Uint8Array): void {
    this.parts.push(piece.subarray(1));
    if (piece[0] !== 1) return;
    const size = this.parts.reduce((n, p) => n + p.length, 0);
    const whole = new Uint8Array(size);
    let at = 0;
    for (const p of this.parts) {
      whole.set(p, at);
      at += p.length;
    }
    this.parts = [];
    this.onMessage?.(whole);
  }

  close(): void {
    this.queue = [];
    this.channel.close();
    this.pc.close();
  }
}

function opened(pc: RTCPeerConnection, channel: RTCDataChannel): Promise<Link> {
  return new Promise((resolve, reject) => {
    const link = new ChannelLink(pc, channel);
    if (channel.readyState === 'open') return resolve(link);
    channel.addEventListener('open', () => resolve(link), { once: true });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') reject(new Error(t('The connection failed; the networks may block direct connections')));
    });
  });
}

/** One invite for one guest: the offer to send, and the link once their answer is in. */
export interface Invite {
  /** Text for the invite link. */
  offer: string;
  /** Takes the guest's answer code; resolves when the connection is up. */
  accept(answer: string): Promise<Link>;
  cancel(): void;
}

export async function createInvite(): Promise<Invite> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel('jam', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const offer = await packDescription(pc.localDescription!);
  return {
    offer,
    async accept(answer) {
      await pc.setRemoteDescription(await unpackDescription(answer, 'answer'));
      return opened(pc, channel);
    },
    cancel: () => pc.close(),
  };
}

/**
 * Guest side: the answer code to send back, and the link once the host has
 * taken it. `wrongOffer` is the error for text that is no offer at all.
 */
export async function answerInvite(offer: string, wrongOffer?: string): Promise<{ answer: string; link: Promise<Link>; cancel(): void }> {
  const description = await unpackDescription(offer, 'offer', wrongOffer);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const link = new Promise<Link>((resolve, reject) => {
    pc.addEventListener('datachannel', (event) => opened(pc, event.channel).then(resolve, reject), { once: true });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') reject(new Error(t('The connection failed; the networks may block direct connections')));
    });
  });
  await pc.setRemoteDescription(description);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { answer: await packDescription(pc.localDescription!), link, cancel: () => pc.close() };
}

// ---- Tabs of one browser ------------------------------------------------------

type TabMessage = { from: string; to: string; kind: 'open' | 'data' | 'close'; data?: Uint8Array };

class TabLink implements Link {
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;

  constructor(
    private readonly channel: BroadcastChannel,
    private readonly me: string,
    private readonly other: string,
  ) {}

  send(bytes: Uint8Array): void {
    if (!this.closed) this.channel.postMessage({ from: this.me, to: this.other, kind: 'data', data: bytes } satisfies TabMessage);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.postMessage({ from: this.me, to: this.other, kind: 'close' } satisfies TabMessage);
    this.onClose?.();
  }

  /** The other end went away. */
  dropped(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

const channelName = (room: string) => `webtracker-jam-${room}`;

/** Host: lets tabs that join `room` in. Returns a function that stops listening. */
export function listenInTabs(room: string, onGuest: (link: Link) => void): () => void {
  const channel = new BroadcastChannel(channelName(room));
  const links = new Map<string, TabLink>();
  channel.addEventListener('message', (event: MessageEvent<TabMessage>) => {
    const { from, to, kind, data } = event.data;
    if (to !== 'host') return;
    if (kind === 'open' && !links.has(from)) {
      const link = new TabLink(channel, 'host', from);
      links.set(from, link);
      onGuest(link);
    } else if (kind === 'data' && data) links.get(from)?.onMessage?.(data);
    else if (kind === 'close') {
      links.get(from)?.dropped();
      links.delete(from);
    }
  });
  return () => {
    for (const link of links.values()) link.close();
    channel.close();
  };
}

/** Guest: a link to the host tab of `room`. */
export function joinInTab(room: string): Link {
  const channel = new BroadcastChannel(channelName(room));
  const me = Math.random().toString(36).slice(2);
  const link = new TabLink(channel, me, 'host');
  channel.addEventListener('message', (event: MessageEvent<TabMessage>) => {
    const { to, kind, data } = event.data;
    if (to !== me) return;
    if (kind === 'data' && data) link.onMessage?.(data);
    else if (kind === 'close') link.dropped();
  });
  channel.postMessage({ from: me, to: 'host', kind: 'open' } satisfies TabMessage);
  addEventListener('pagehide', () => link.close());
  return link;
}

/** A fresh room name for jamming in tabs. */
export function newRoom(): string {
  return Math.random().toString(36).slice(2, 10);
}
