import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pipe, toBase64Url } from '../storage/share.ts';
import { answerInvite, createInvite, jamFromHash, joinInTab, listenInTabs, newRoom, transferFromHash } from './links.ts';
import type { Link } from './session.ts';

/**
 * Jam links. The WebRTC side runs against an in-process RTCPeerConnection
 * that pairs the two ends through the offer and answer they swap, so the
 * invite codes, message splitting and back pressure are real; what a real
 * network does with them (NAT, STUN) is not tested.
 */

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer: FakeChannel | null = null;
  sent: Uint8Array[] = [];

  send(data: Uint8Array): void {
    this.sent.push(data);
    const copy = data.slice().buffer;
    this.peer?.dispatchEvent(new MessageEvent('message', { data: copy }));
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

const peers = new Map<string, FakePeer>();
let gathering: 'complete' | 'gathering' = 'complete';

class FakePeer extends EventTarget {
  static all: FakePeer[] = [];
  readonly id = Math.random().toString(36).slice(2);
  localDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState = gathering;
  connectionState: RTCPeerConnectionState = 'new';
  channel: FakeChannel | null = null;
  remote: FakePeer | null = null;

  constructor(readonly config: RTCConfiguration) {
    super();
    peers.set(this.id, this);
    FakePeer.all.push(this);
  }

  createDataChannel(): FakeChannel {
    this.channel = new FakeChannel();
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: `v=0 offer ${this.id}` };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: `v=0 answer ${this.id}` };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    const other = peers.get(d.sdp!.split(' ').pop()!)!;
    this.remote = other;
    if (d.type !== 'answer') return;
    // The host took the answer: connect the host's channel to a new one on the guest.
    const guestChannel = new FakeChannel();
    guestChannel.peer = this.channel;
    this.channel!.peer = guestChannel;
    queueMicrotask(() => {
      const event = Object.assign(new Event('datachannel'), { channel: guestChannel });
      other.dispatchEvent(event);
      this.channel!.open();
      guestChannel.open();
    });
  }
  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  finishGathering(): void {
    this.iceGatheringState = 'complete';
    this.dispatchEvent(new Event('icegatheringstatechange'));
  }
  close(): void {
    this.connectionState = 'closed';
  }
}

beforeEach(() => {
  gathering = 'complete';
  FakePeer.all = [];
  vi.stubGlobal('RTCPeerConnection', FakePeer);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connect(): Promise<{ host: Link; guest: Link; hostPeer: FakePeer; guestPeer: FakePeer }> {
  const invite = await createInvite();
  const reply = await answerInvite(invite.offer);
  const host = await invite.accept(reply.answer);
  const guest = await reply.link;
  const [hostPeer, guestPeer] = FakePeer.all as [FakePeer, FakePeer];
  return { host, guest, hostPeer, guestPeer };
}

describe('jam addresses', () => {
  it('reads WebRTC and tab jams and transfers from the address fragment', () => {
    expect(jamFromHash('#jam=abc')).toEqual({ kind: 'rtc', value: 'abc' });
    expect(jamFromHash('jam-tab=room1')).toEqual({ kind: 'tab', value: 'room1' });
    expect(jamFromHash('#song=xyz')).toBeNull();
    expect(transferFromHash('#transfer=offer')).toBe('offer');
    expect(transferFromHash('#transfer=')).toBeNull();
  });

  it('makes short random room names', () => {
    const a = newRoom();
    expect(a).toMatch(/^[a-z0-9]{1,8}$/);
    expect(newRoom()).not.toBe(a);
  });
});

describe('WebRTC links', () => {
  it('asks a public STUN server only', async () => {
    await createInvite();
    expect(FakePeer.all[0]!.config.iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('swaps compressed codes and carries messages both ways', async () => {
    const { host, guest } = await connect();
    const got: number[][] = [];
    guest.onMessage = (b) => got.push([...b]);
    host.onMessage = (b) => got.push([...b].map((v) => -v));
    host.send(new Uint8Array([1, 2, 3]));
    guest.send(new Uint8Array([4]));
    expect(got).toEqual([[1, 2, 3], [-4]]);
  });

  it('splits big messages into pieces and puts them back together', async () => {
    const { host, guest, hostPeer } = await connect();
    const big = Uint8Array.from({ length: 40_000 }, (_, i) => i & 255);
    let got: Uint8Array | null = null;
    guest.onMessage = (b) => (got = b);
    host.send(big);
    expect(hostPeer.channel!.sent.map((p) => [p.length, p[0]])).toEqual([
      [16 * 1024 + 1, 0],
      [16 * 1024 + 1, 0],
      [40_000 - 32 * 1024 + 1, 1],
    ]);
    expect(got).toEqual(big);
    // An empty message is one piece too.
    host.send(new Uint8Array());
    expect(got).toEqual(new Uint8Array());
  });

  it('waits while the send buffer is full', async () => {
    const { host, hostPeer } = await connect();
    const channel = hostPeer.channel!;
    channel.bufferedAmount = 2 * 1024 * 1024;
    host.send(new Uint8Array([1]));
    expect(channel.sent).toHaveLength(0);
    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event('bufferedamountlow'));
    expect(channel.sent).toHaveLength(1);
  });

  it('reports a closed channel or a failed connection, and closes both', async () => {
    const { host, guest, hostPeer, guestPeer } = await connect();
    const closed: string[] = [];
    host.onClose = () => closed.push('host');
    guest.onClose = () => closed.push('guest');
    guestPeer.setState('failed');
    expect(closed).toEqual(['guest']);
    host.close();
    expect(hostPeer.connectionState).toBe('closed');
    expect(closed).toEqual(['guest', 'host']);
  });

  it('turns broken and mismatched codes into readable errors', async () => {
    const invite = await createInvite();
    await expect(answerInvite('not base64 at all')).rejects.toThrow('This code is incomplete or broken');
    await expect(answerInvite(invite.offer.slice(0, 10))).rejects.toThrow('This code is incomplete or broken');
    // The invite where the answer belongs, and the other way round.
    await expect(invite.accept(invite.offer)).rejects.toThrow('This is not an answer code');
    const reply = await answerInvite(invite.offer);
    await expect(answerInvite(reply.answer)).rejects.toThrow('This is not a jam invite');
    await expect(answerInvite(reply.answer, 'Not a transfer link')).rejects.toThrow('Not a transfer link');
  });

  it('refuses a description without sdp', async () => {
    const text = toBase64Url(await pipe(new TextEncoder().encode('{"type":"offer"}'), new CompressionStream('deflate-raw')));
    await expect(answerInvite(text)).rejects.toThrow('This is not a jam invite');
  });

  it('fails the invite when the connection fails before it opens', async () => {
    const invite = await createInvite();
    const reply = await answerInvite(invite.offer);
    const [hostPeer, guestPeer] = FakePeer.all as [FakePeer, FakePeer];
    // Keep the host channel from opening: it fails first.
    hostPeer.setRemoteDescription = async () => {};
    const accepted = invite.accept(reply.answer);
    // Let the answer code unpack before the connection fails.
    await new Promise((resolve) => setTimeout(resolve, 20));
    hostPeer.setState('failed');
    await expect(accepted).rejects.toThrow('The connection failed');
    guestPeer.setState('failed');
    await expect(reply.link).rejects.toThrow('The connection failed');
    reply.cancel();
    invite.cancel();
    expect(guestPeer.connectionState).toBe('closed');
  });

  it('waits for the addresses to be gathered, or five seconds at most', async () => {
    gathering = 'gathering';
    const quick = createInvite();
    await vi.waitFor(() => expect(FakePeer.all).toHaveLength(1));
    await Promise.resolve();
    FakePeer.all[0]!.dispatchEvent(new Event('icegatheringstatechange'));
    FakePeer.all[0]!.finishGathering();
    expect((await quick).offer.length).toBeGreaterThan(0);

    vi.useFakeTimers();
    const slow = createInvite();
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void slow.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await slow).offer.length).toBeGreaterThan(0);
  });
});

describe('tab links', () => {
  beforeEach(() => {
    vi.stubGlobal('addEventListener', vi.fn());
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('connects guests to the host tab of a room and carries messages both ways', async () => {
    const room = newRoom();
    const guests: Link[] = [];
    const stop = listenInTabs(room, (link) => guests.push(link));
    const guest = joinInTab(room);
    await tick();
    expect(guests).toHaveLength(1);
    const atHost: number[] = [];
    const atGuest: number[] = [];
    guests[0]!.onMessage = (b) => atHost.push(...b);
    guest.onMessage = (b) => atGuest.push(...b);
    guest.send(new Uint8Array([7]));
    guests[0]!.send(new Uint8Array([8]));
    await tick();
    expect(atHost).toEqual([7]);
    expect(atGuest).toEqual([8]);
    stop();
  });

  it('tells each side when the other leaves', async () => {
    const room = newRoom();
    const guests: Link[] = [];
    const stop = listenInTabs(room, (link) => guests.push(link));
    const guest = joinInTab(room);
    await tick();
    const hostSide = vi.fn();
    guests[0]!.onClose = hostSide;
    guest.close();
    guest.close();
    await tick();
    expect(hostSide).toHaveBeenCalledOnce();
    // Nothing goes out on a closed link.
    guest.send(new Uint8Array([1]));

    const second = joinInTab(room);
    const guestSide = vi.fn();
    second.onClose = guestSide;
    await tick();
    stop();
    await tick();
    expect(guestSide).toHaveBeenCalledOnce();
  });

  it('closes the guest link when the page goes away', () => {
    const listen = vi.fn();
    vi.stubGlobal('addEventListener', listen);
    const link = joinInTab(newRoom());
    const onClose = vi.fn();
    link.onClose = onClose;
    expect(listen).toHaveBeenCalledWith('pagehide', expect.any(Function));
    (listen.mock.calls[0]![1] as () => void)();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
