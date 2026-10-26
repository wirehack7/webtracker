/**
 * An in-process RTCPeerConnection that pairs the two ends through the offer
 * and answer they swap, so invite codes and data channels run for real
 * without a network.
 */
import { vi } from 'vitest';

export class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer: FakeChannel | null = null;
  sent: Uint8Array[] = [];

  send(data: Uint8Array): void {
    this.sent.push(data);
    const copy = data.slice().buffer;
    const peer = this.peer;
    // Like a network, the message arrives in a later task.
    setTimeout(() => peer?.dispatchEvent(new MessageEvent('message', { data: copy })), 0);
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  close(): void {
    this.readyState = 'closed';
    // Browsers fire close later, not inside close().
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
    // The other end closes too.
    if (this.peer?.readyState === 'open') setTimeout(() => this.peer?.close(), 0);
  }
}

const peers = new Map<string, FakePeer>();
let gathering: 'complete' | 'gathering' = 'complete';

/** Whether new peers have their ICE candidates at once. */
export function setGathering(state: 'complete' | 'gathering'): void {
  gathering = state;
}

export class FakePeer extends EventTarget {
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

/** Puts the fake in place of RTCPeerConnection, with peers that gather at once. */
export function installFakeRtc(): void {
  gathering = 'complete';
  FakePeer.all = [];
  vi.stubGlobal('RTCPeerConnection', FakePeer);
}
