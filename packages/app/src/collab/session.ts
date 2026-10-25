/**
 * A jam: several people editing one song at the same time.
 *
 * One person hosts. Everyone applies their own edits at once and sends them
 * as operations (see ops.ts); the host puts all operations into one order,
 * applies them and passes each on to everybody, the sender included. A guest
 * applies the operations of others as they come and then lays its own,
 * not yet passed back, on top again, which is where the host will put them
 * too. So everyone ends up with the host's song, even when two people change
 * the same cell at once (the one the host gets last wins).
 *
 * The session only sees bytes on a `Link`, so it runs the same over WebRTC,
 * between tabs and in tests.
 */

import { CELL_SIZE, type Song } from '@webtracker/engine';
import type { SongEdit } from '../editor/song-editor.ts';
import { decode, encode } from './codec.ts';
import { applyOp, instrumentCopy, layoutOf, type Op } from './ops.ts';

/** A connection to one other person, carrying whole messages. */
export interface Link {
  send(bytes: Uint8Array): void;
  close(): void;
  onMessage: ((bytes: Uint8Array) => void) | null;
  onClose: (() => void) | null;
}

export interface Peer {
  id: number;
  name: string;
  colour: string;
}

/** Where someone's cursor is. */
export interface Cursor {
  pattern: number;
  row: number;
  channel: number;
}

type Wire =
  | { t: 'hello'; name: string }
  | { t: 'welcome'; you: number; song: Song; peers: Peer[] }
  | { t: 'op'; from: number; op: Op }
  | { t: 'cursor'; from: number; cursor: Cursor | null }
  | { t: 'peers'; peers: Peer[] }
  | { t: 'ping' };

/** What the session needs from the app around it. */
export interface JamDocument {
  /** The song being edited. */
  song(): Song;
  /** Someone else's change landed in the song. */
  applied(edits: SongEdit[]): void;
  /** A guest got the host's song and starts editing it. */
  adopt(song: Song): void;
}

export const PEER_COLOURS = ['#ff5f5f', '#5fd75f', '#ffd75f', '#5fafff', '#ff87ff', '#5fffff', '#ffaf5f', '#afafff'];
const HOST_ID = 0;
/** Instrument edits (knob drags, drawing in a sample) are sent at most this often. */
const INSTRUMENT_DELAY = 100;
const CURSOR_DELAY = 60;
const PING_EVERY = 4000;
/** A link silent this long is taken as gone, for tabs closed without saying goodbye. */
const SILENT_FOR = 15000;

function sameData(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Copies of the song as last sent or received, to work out what a local edit changed. */
class Shadow {
  private patterns = new Map<number, Uint8Array>();
  private samples = new Map<number, Float32Array[]>();

  reset(song: Song): void {
    this.patterns = new Map(song.patterns.map((p, i) => [i, p.data.slice()]));
    this.samples = new Map(song.instruments.map((ins, i) => [i, ins.samples.map((s) => s.data.slice())]));
  }

  capture(song: Song, edit: SongEdit): void {
    if (edit.kind === 'song') this.reset(song);
    else if (edit.kind === 'pattern') {
      const p = song.patterns[edit.index];
      if (p) this.patterns.set(edit.index, p.data.slice());
    } else if (edit.kind === 'instrument') {
      const ins = song.instruments[edit.index];
      if (ins) this.samples.set(edit.index, ins.samples.map((s) => s.data.slice()));
    }
  }

  /** The operation for a local change to pattern `index`, or null when nothing changed. */
  patternOp(song: Song, index: number): Op | null {
    const pattern = song.patterns[index];
    if (!pattern) return null;
    const old = this.patterns.get(index);
    this.patterns.set(index, pattern.data.slice());
    if (!old || old.length !== pattern.data.length) return { k: 'pattern', p: index, rows: pattern.rows, data: pattern.data.slice() };
    const cells: number[] = [];
    for (let o = 0; o < old.length; o += CELL_SIZE) {
      for (let b = 0; b < CELL_SIZE; b++) {
        if (old[o + b] !== pattern.data[o + b]) {
          cells.push(o / CELL_SIZE);
          break;
        }
      }
    }
    if (!cells.length) return null;
    const bytes = new Uint8Array(cells.length * CELL_SIZE);
    cells.forEach((c, i) => bytes.set(pattern.data.subarray(c * CELL_SIZE, (c + 1) * CELL_SIZE), i * CELL_SIZE));
    return { k: 'cells', p: index, cells: Uint32Array.from(cells), bytes };
  }

  instrumentOp(song: Song, index: number): Op | null {
    const ins = song.instruments[index];
    if (!ins) return null;
    const old = this.samples.get(index);
    const keepData = !!old && old.length === ins.samples.length && ins.samples.every((s, j) => sameData(s.data, old[j]!));
    if (!keepData) this.samples.set(index, ins.samples.map((s) => s.data.slice()));
    return { k: 'instrument', i: index, ins: instrumentCopy(ins, !keepData), keepData };
  }
}

export class JamSession {
  readonly role: 'host' | 'guest';
  /** This person's id; the host is 0, a guest learns its id on joining. */
  me = HOST_ID;
  peers: Peer[] = [];
  /** Other people's cursors, by id. */
  readonly cursors = new Map<number, Cursor>();
  onPeers: (() => void) | null = null;
  onCursors: (() => void) | null = null;
  /** The jam is over for this person (`reason` says why); the song stays as it is. */
  onEnd: ((reason: string) => void) | null = null;
  /** A guest got the song and is in. */
  onJoined: (() => void) | null = null;

  private readonly shadow = new Shadow();
  /** Guest: own operations the host has not passed back yet, oldest first. */
  private pending: Op[] = [];
  /** Host: one link per guest, by id. */
  private readonly guests = new Map<number, Link>();
  private hostLink: Link | null = null;
  private nextId = 1;
  private joined = false;
  private ended = false;
  private readonly instrumentsDue = new Set<number>();
  private instrumentTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorDue: Cursor | null | undefined;
  /** Host: its own cursor as last sent, for people who join later. */
  private ownCursor: Cursor | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heard = new Map<Link, number>();
  private readonly pinger: ReturnType<typeof setInterval>;

  private constructor(
    private readonly doc: JamDocument,
    role: 'host' | 'guest',
    readonly name: string,
  ) {
    this.role = role;
    this.pinger = setInterval(() => this.keepAlive(), PING_EVERY);
  }

  /** Starts a jam on the current song; guests come in through `addGuest`. */
  static host(doc: JamDocument, name: string): JamSession {
    const session = new JamSession(doc, 'host', name);
    session.peers = [{ id: HOST_ID, name, colour: PEER_COLOURS[0]! }];
    session.shadow.reset(doc.song());
    session.joined = true;
    return session;
  }

  /** Joins the jam at the other end of `link`; the song arrives with the welcome. */
  static join(doc: JamDocument, name: string, link: Link): JamSession {
    const session = new JamSession(doc, 'guest', name);
    session.hostLink = link;
    session.listen(link, (message) => session.fromHost(message), () => session.end('The host left the jam. The song stays here.'));
    session.post(link, { t: 'hello', name });
    return session;
  }

  get active(): boolean {
    return this.joined && !this.ended;
  }

  /** Host: lets in whoever is at the other end of `link`. */
  addGuest(link: Link): void {
    if (this.role !== 'host' || this.ended) return;
    let id = -1;
    this.listen(
      link,
      (message) => {
        if (message.t === 'hello' && id < 0) {
          id = this.nextId++;
          this.guests.set(id, link);
          this.flushInstruments();
          const colour = PEER_COLOURS[id % PEER_COLOURS.length]!;
          this.peers = [...this.peers, { id, name: message.name.slice(0, 24) || `Guest ${id}`, colour }];
          this.post(link, { t: 'welcome', you: id, song: this.doc.song(), peers: this.peers });
          for (const [from, cursor] of this.cursors) this.post(link, { t: 'cursor', from, cursor });
          if (this.ownCursor) this.post(link, { t: 'cursor', from: HOST_ID, cursor: this.ownCursor });
          this.broadcast({ t: 'peers', peers: this.peers }, id);
          this.onPeers?.();
        } else if (id >= 0) this.fromGuest(id, message);
      },
      () => {
        if (id < 0 || this.ended) return;
        this.guests.delete(id);
        this.peers = this.peers.filter((p) => p.id !== id);
        this.cursors.delete(id);
        this.broadcast({ t: 'peers', peers: this.peers });
        this.broadcast({ t: 'cursor', from: id, cursor: null });
        this.onPeers?.();
        this.onCursors?.();
      },
    );
  }

  /** A change made here, from `SongEditor.onEdit`. */
  local(edit: SongEdit): void {
    if (!this.active) return;
    if (edit.kind === 'instrument') {
      this.instrumentsDue.add(edit.index);
      this.instrumentTimer ??= setTimeout(() => this.flushInstruments(), INSTRUMENT_DELAY);
      return;
    }
    // Keeps the order of edits, so a song-wide change cannot overtake an instrument edit.
    this.flushInstruments();
    const song = this.doc.song();
    let op: Op | null = null;
    if (edit.kind === 'pattern') op = this.shadow.patternOp(song, edit.index);
    else if (edit.kind === 'orders') op = { k: 'orders', orders: [...song.orders], restart: song.restartPosition };
    else if (edit.kind === 'tempo') op = { k: 'tempo', speed: song.initialSpeed, tempo: song.initialTempo };
    else if (edit.kind === 'title') op = { k: 'title', title: song.title };
    else if (edit.kind === 'song') {
      op = { k: 'layout', layout: layoutOf(song) };
      this.shadow.reset(song);
    }
    if (op) this.send(op);
  }

  /** Moves this person's cursor for the others; null hides it. */
  cursor(cursor: Cursor | null): void {
    if (!this.active) return;
    this.cursorDue = cursor;
    this.cursorTimer ??= setTimeout(() => {
      this.cursorTimer = null;
      const due = this.cursorDue;
      this.cursorDue = undefined;
      if (due === undefined || !this.active) return;
      const message: Wire = { t: 'cursor', from: this.me, cursor: due };
      if (this.hostLink) this.post(this.hostLink, message);
      else {
        this.ownCursor = due;
        this.broadcast(message);
      }
    }, CURSOR_DELAY);
  }

  leave(): void {
    if (this.ended) return;
    this.flushInstruments();
    this.end(this.role === 'host' ? 'The jam is over. The song stays here.' : 'You left the jam. The song stays here.');
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.pinger);
    if (this.instrumentTimer) clearTimeout(this.instrumentTimer);
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.hostLink?.close();
    for (const link of this.guests.values()) link.close();
    this.guests.clear();
    this.onEnd?.(reason);
  }

  private flushInstruments(): void {
    if (this.instrumentTimer) clearTimeout(this.instrumentTimer);
    this.instrumentTimer = null;
    if (!this.active) return;
    const song = this.doc.song();
    for (const index of this.instrumentsDue) {
      const op = this.shadow.instrumentOp(song, index);
      if (op) this.send(op);
    }
    this.instrumentsDue.clear();
  }

  private send(op: Op): void {
    if (this.hostLink) {
      this.pending.push(op);
      this.post(this.hostLink, { t: 'op', from: this.me, op });
    } else this.broadcast({ t: 'op', from: HOST_ID, op });
  }

  private fromGuest(id: number, message: Wire): void {
    if (message.t === 'op') {
      this.flushInstruments();
      this.apply([message.op]);
      this.broadcast({ t: 'op', from: id, op: message.op });
    } else if (message.t === 'cursor') {
      this.setCursor(id, message.cursor);
      this.broadcast({ t: 'cursor', from: id, cursor: message.cursor }, id);
    }
  }

  private fromHost(message: Wire): void {
    if (message.t === 'welcome') {
      this.me = message.you;
      this.peers = message.peers;
      this.joined = true;
      this.doc.adopt(message.song);
      this.shadow.reset(this.doc.song());
      this.onPeers?.();
      this.onJoined?.();
      return;
    }
    if (!this.joined) return;
    if (message.t === 'op') {
      if (message.from === this.me) {
        // Our own operation, now in the host's order; the song already has it.
        this.pending.shift();
        return;
      }
      this.flushInstruments();
      // Their operation goes under ours, as on the host.
      this.apply([message.op, ...this.pending]);
    } else if (message.t === 'peers') {
      this.peers = message.peers;
      for (const id of this.cursors.keys()) if (!this.peers.some((p) => p.id === id)) this.cursors.delete(id);
      this.onPeers?.();
      this.onCursors?.();
    } else if (message.t === 'cursor' && message.from !== this.me) this.setCursor(message.from, message.cursor);
  }

  private apply(ops: Op[]): void {
    const song = this.doc.song();
    const known = song.patterns.length;
    const edits: SongEdit[] = [];
    for (const op of ops) {
      const edit = applyOp(song, op);
      if (!edits.some((e) => JSON.stringify(e) === JSON.stringify(edit))) edits.push(edit);
    }
    // Patterns that came into being on the way (orders pointing past the end) reach the player too.
    for (let p = known; p < song.patterns.length; p++) edits.push({ kind: 'pattern', index: p });
    for (const edit of edits) this.shadow.capture(song, edit);
    this.doc.applied(edits);
  }

  private setCursor(id: number, cursor: Cursor | null): void {
    if (cursor) this.cursors.set(id, cursor);
    else this.cursors.delete(id);
    this.onCursors?.();
  }

  private post(link: Link, message: Wire): void {
    try {
      link.send(encode(message));
    } catch {
      link.close();
    }
  }

  private broadcast(message: Wire, except?: number): void {
    const bytes = encode(message);
    for (const [id, link] of this.guests) {
      if (id === except) continue;
      try {
        link.send(bytes);
      } catch {
        link.close();
      }
    }
  }

  private listen(link: Link, onMessage: (message: Wire) => void, onClose: () => void): void {
    this.heard.set(link, Date.now());
    link.onMessage = (bytes) => {
      this.heard.set(link, Date.now());
      if (this.ended) return;
      let message: Wire;
      try {
        message = decode(bytes) as Wire;
      } catch {
        return;
      }
      if (message.t !== 'ping') onMessage(message);
    };
    let closed = false;
    link.onClose = () => {
      if (closed) return;
      closed = true;
      this.heard.delete(link);
      onClose();
    };
  }

  private keepAlive(): void {
    const now = Date.now();
    for (const [link, at] of this.heard) {
      if (now - at > SILENT_FOR) {
        link.close();
        link.onClose?.();
      } else this.post(link, { t: 'ping' });
    }
  }
}
