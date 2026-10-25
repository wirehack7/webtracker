import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSong, readCell, writeCell, type Song } from '@webtracker/engine';
import { SongEditor } from '../editor/song-editor.ts';
import { decode, encode } from './codec.ts';
import { JamSession, type Link } from './session.ts';

/** Two link ends whose messages wait in a queue until `deliver` runs. */
class Wire {
  private queue: { to: End; bytes: Uint8Array }[] = [];
  readonly a: End;
  readonly b: End;
  constructor() {
    this.a = new End(this);
    this.b = new End(this);
    this.a.other = this.b;
    this.b.other = this.a;
  }
  push(to: End, bytes: Uint8Array): void {
    this.queue.push({ to, bytes });
  }
  /** Delivers up to `count` waiting messages, oldest first. */
  deliver(count = Infinity): number {
    let n = 0;
    while (this.queue.length && n < count) {
      const { to, bytes } = this.queue.shift()!;
      to.onMessage?.(bytes);
      n++;
    }
    return n;
  }
  get waiting(): number {
    return this.queue.length;
  }
}

class End implements Link {
  other!: End;
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;
  constructor(private readonly wire: Wire) {}
  send(bytes: Uint8Array): void {
    if (!this.closed) this.wire.push(this.other, bytes);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.other.closed = true;
    this.onClose?.();
    this.other.onClose?.();
  }
}

interface Person {
  editor: SongEditor;
  session: JamSession;
  ended: string | null;
}

function person(make: (doc: Parameters<typeof JamSession.host>[0]) => JamSession, song = createSong(4)): Person {
  const editor = new SongEditor(song, () => {});
  const p = { editor, ended: null } as Person;
  p.session = make({
    song: () => editor.song,
    applied: (edits) => editor.applyRemote(edits, 'jam'),
    adopt: (s) => editor.replaceSong(s),
  });
  p.session.onEnd = (reason) => (p.ended = reason);
  editor.onEdit = (edit) => p.session.local(edit);
  return p;
}

function setup(guests = 1) {
  const host = person((doc) => JamSession.host(doc, 'Host'));
  const wires: Wire[] = [];
  const people: Person[] = [host];
  for (let i = 0; i < guests; i++) {
    const wire = new Wire();
    host.session.addGuest(wire.a);
    people.push(person((doc) => JamSession.join(doc, `Guest ${i + 1}`, wire.b)));
    wires.push(wire);
  }
  const settle = () => {
    vi.advanceTimersByTime(200);
    while (wires.reduce((n, w) => n + w.deliver(), 0) > 0) vi.advanceTimersByTime(200);
  };
  settle();
  return { host, guests: people.slice(1), people, wires, settle };
}

const note = (s: Song, pattern: number, row: number, channel: number) => readCell(s, s.patterns[pattern]!, row, channel).note;
const songBytes = (s: Song) => encode(s);

function put(p: Person, row: number, channel: number, value: number, pattern = 0): void {
  p.editor.editPattern(pattern, 'note', (pat) => writeCell(p.editor.song, pat, row, channel, { note: value }));
}

function expectSame(people: Person[]): void {
  const first = songBytes(people[0]!.editor.song);
  for (const p of people.slice(1)) expect(songBytes(p.editor.song)).toEqual(first);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('codec', () => {
  it('round-trips plain values and typed arrays', () => {
    const value = { a: 1, s: 'x', list: [true, null], u8: Uint8Array.of(1, 2, 3), f: Float32Array.of(0.5, -1), u32: Uint32Array.of(7, 1e9) };
    const back = decode(encode(value)) as typeof value;
    expect(back).toEqual(value);
    expect(back.f).toBeInstanceOf(Float32Array);
    expect(back.u32).toBeInstanceOf(Uint32Array);
  });

  it('round-trips a song', () => {
    const song = createSong(6);
    expect(decode(encode(song))).toEqual(song);
  });
});

describe('JamSession', () => {
  it('gives a guest the host song and the list of people', () => {
    const host = person((doc) => JamSession.host(doc, 'Host'));
    put(host, 3, 1, 49);
    const wire = new Wire();
    host.session.addGuest(wire.a);
    const guest = person((doc) => JamSession.join(doc, 'Ann', wire.b), createSong(8));
    wire.deliver();
    wire.deliver();
    expect(guest.editor.song.channels).toBe(4);
    expect(note(guest.editor.song, 0, 3, 1)).toBe(49);
    expect(guest.session.me).toBe(1);
    expect(guest.session.peers.map((p) => p.name)).toEqual(['Host', 'Ann']);
    expect(host.session.peers.map((p) => p.name)).toEqual(['Host', 'Ann']);
  });

  it('passes edits both ways', () => {
    const { host, guests, settle, people } = setup(2);
    put(host, 0, 0, 10);
    put(guests[0]!, 1, 1, 20);
    put(guests[1]!, 2, 2, 30);
    settle();
    for (const p of people) {
      expect(note(p.editor.song, 0, 0, 0)).toBe(10);
      expect(note(p.editor.song, 0, 1, 1)).toBe(20);
      expect(note(p.editor.song, 0, 2, 2)).toBe(30);
    }
    expectSame(people);
  });

  it('agrees on one value when two people change the same cell at once', () => {
    const { host, guests, settle, people } = setup(2);
    put(guests[0]!, 5, 0, 11);
    put(guests[1]!, 5, 0, 22);
    put(host, 5, 0, 33);
    settle();
    expectSame(people);
  });

  it('keeps edits others made to a pattern when undoing your own', () => {
    const { host, guests, settle, people } = setup(1);
    const guest = guests[0]!;
    put(guest, 0, 0, 40);
    settle();
    put(host, 1, 0, 41);
    settle();
    expect(guest.editor.undo()).toBe('note');
    settle();
    for (const p of people) {
      expect(note(p.editor.song, 0, 0, 0)).toBe(0);
      expect(note(p.editor.song, 0, 1, 0)).toBe(41);
    }
    // Others' edits are not in your undo history.
    expect(guest.editor.undo()).toBeNull();
  });

  it('sends instrument knob turns without the sample data', () => {
    const { host, guests, settle, people, wires } = setup(1);
    const longest = 40000;
    host.editor.editInstrument(0, 'sample', (ins) => (ins.samples[0]!.data = new Float32Array(longest / 4).fill(0.25)));
    settle();
    const sizes: number[] = [];
    const end = wires[0]!.b;
    const receive = end.onMessage!;
    end.onMessage = (bytes) => {
      sizes.push(bytes.length);
      receive(bytes);
    };
    for (let v = 10; v < 20; v++) host.editor.editInstrument(0, 'volume', (ins) => (ins.samples[0]!.volume = v));
    settle();
    expect(guests[0]!.editor.song.instruments[0]!.samples[0]!.volume).toBe(19);
    // The ten turns are sent together and leave the sample data out.
    expect(sizes.filter((n) => n > 200)).toHaveLength(1);
    expect(Math.max(...sizes)).toBeLessThan(2000);
    expectSame(people);
  });

  it('passes sample edits with their data', () => {
    const { guests, settle, people } = setup(1);
    guests[0]!.editor.editInstrument(1, 'reverse', (ins) => ins.samples[0]!.data.reverse());
    settle();
    expectSame(people);
  });

  it('passes song-wide changes such as the channel count', () => {
    const { host, guests, settle, people } = setup(2);
    guests[1]!.editor.setChannels(6);
    // Tempo and title are not part of the layout, so a channel change in flight leaves them be.
    host.editor.setTempo(5, 140);
    settle();
    put(guests[0]!, 0, 5, 50);
    host.editor.setTitle('jam');
    guests[0]!.editor.editOrders('orders', (o) => [...o, 3]);
    settle();
    for (const p of people) {
      expect(p.editor.song.channels).toBe(6);
      expect(p.editor.song.initialTempo).toBe(140);
      expect(p.editor.song.title).toBe('jam');
      expect(p.editor.song.orders.at(-1)).toBe(3);
      expect(note(p.editor.song, 0, 0, 5)).toBe(50);
    }
    expectSame(people);
  });

  it('agrees on the song whatever order messages arrive in', () => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 20; round++) {
      const { people, wires, settle } = setup(3);
      for (let step = 0; step < 60; step++) {
        const p = people[Math.floor(random() * people.length)]!;
        const what = random();
        if (what < 0.6) put(p, Math.floor(random() * 4), Math.floor(random() * 2), 1 + Math.floor(random() * 90), Math.floor(random() * 2));
        else if (what < 0.7) p.editor.undo();
        else if (what < 0.75) p.editor.editPattern(0, 'insert row', (pat) => {
          pat.data.copyWithin(20, 0, pat.data.length - 20);
        });
        else if (what < 0.8) p.editor.editInstrument(0, 'volume', (ins) => (ins.samples[0]!.volume = Math.floor(random() * 64)));
        else if (what < 0.83) p.editor.setChannels(3 + Math.floor(random() * 3));
        // Some messages get through now, others later.
        for (const wire of wires) wire.deliver(Math.floor(random() * 3));
        if (random() < 0.2) vi.advanceTimersByTime(150);
      }
      settle();
      expectSame(people);
    }
  });

  it('tells a guest when the host leaves, and the host when a guest leaves', () => {
    const { host, guests, settle } = setup(2);
    const onPeers = vi.fn();
    host.session.onPeers = onPeers;
    guests[0]!.session.leave();
    settle();
    expect(host.session.peers.map((p) => p.name)).toEqual(['Host', 'Guest 2']);
    expect(guests[1]!.session.peers.map((p) => p.name)).toEqual(['Host', 'Guest 2']);
    host.session.leave();
    expect(guests[1]!.ended).toMatch(/host left/);
    expect(host.ended).toMatch(/over/);
  });

  it('shows cursors of the others', () => {
    const { host, guests, settle } = setup(2);
    guests[0]!.session.cursor({ pattern: 0, row: 4, channel: 1 });
    host.session.cursor({ pattern: 1, row: 2, channel: 0 });
    settle();
    expect(guests[1]!.session.cursors.get(1)).toEqual({ pattern: 0, row: 4, channel: 1 });
    expect(guests[1]!.session.cursors.get(0)).toEqual({ pattern: 1, row: 2, channel: 0 });
    expect(host.session.cursors.get(1)).toEqual({ pattern: 0, row: 4, channel: 1 });
    expect(guests[0]!.session.cursors.has(1)).toBe(false);
  });

  it('drops a link that has gone silent', () => {
    const { host, wires } = setup(1);
    // Nothing gets through any more.
    wires[0]!.b.onMessage = null;
    wires[0]!.a.onMessage = null;
    vi.advanceTimersByTime(20000);
    expect(host.session.peers).toHaveLength(1);
  });
});
