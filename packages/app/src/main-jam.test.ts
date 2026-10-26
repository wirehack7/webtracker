// @vitest-environment happy-dom
import { createSong, readCell, writeCell, type Song } from '@webtracker/engine';
import { saveXm, unzipAll } from '@webtracker/formats';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerInvite, createInvite, joinInTab, listenInTabs } from './collab/links.ts';
import { JamSession, type JamDocument, type Link } from './collab/session.ts';
import type { SongEdit } from './editor/song-editor.ts';
import { createBackup, SETTINGS_FILE } from './storage/backup.ts';
import { bootApp as bootPage, shutdownApp, type App, type BootOptions } from './test-app.ts';
import { installFakeRtc } from './test-rtc.ts';

/**
 * Jams and transfers on the tracker page. The other browser is played by
 * the test: its own JamSession over the in-process WebRTC fake, or over
 * BroadcastChannel for tabs. Real networks (NAT, STUN) are not part of it.
 */

let app: App;
const sessions: JamSession[] = [];

beforeEach(installFakeRtc);

/** Boots the page; the boot clears stand-ins, so WebRTC's goes back in after. */
async function bootApp(options?: BootOptions): Promise<App> {
  const page = await bootPage(options);
  installFakeRtc();
  return page;
}
afterEach(() => {
  for (const session of sessions.splice(0)) session.leave();
  shutdownApp();
});

/** The other person's side of a jam: a song and what reached it. */
interface Remote extends JamDocument {
  current: Song;
  edits: SongEdit[][];
}

function remote(song: Song = createSong(4)): Remote {
  const doc: Remote = {
    current: song,
    edits: [] as SongEdit[][],
    song: () => doc.current,
    applied: (edits: SongEdit[]) => void doc.edits.push(edits),
    adopt: (next: Song) => void (doc.current = next),
  };
  return doc;
}

function track(session: JamSession): JamSession {
  sessions.push(session);
  return session;
}

const input = (selector: string) => app.$<HTMLInputElement>(selector);
const info = () => app.$('#jam-info').textContent;
const visible = (selector: string) => !app.$(selector).hidden;
const people = () => [...app.$('#jam-people').children].map((li) => li.textContent);

/** Hosts a jam on the page and lets a guest in through an invite link and an answer code. */
async function hostWithGuest(name = 'Bob') {
  app.click('#jam-open');
  app.click('#jam-host');
  app.click('#jam-invite');
  await vi.waitFor(() => expect(input('#jam-invite-url').value).toMatch(/#jam=/));
  const offer = input('#jam-invite-url').value.split('#jam=')[1]!;
  const reply = await answerInvite(offer);
  input('#jam-answer').value = reply.answer;
  app.click('#jam-connect');
  const doc = remote();
  const guest = track(JamSession.join(doc, name, await reply.link));
  await vi.waitFor(() => expect(guest.active).toBe(true));
  return { doc, guest };
}

describe('hosting a jam', () => {
  it('starts, invites a guest by link and code, and shares edits and cursors both ways', async () => {
    app = await bootApp({ storage: { 'webtracker.jamName': 'Ann' } });
    expect(input('#jam-name').value).toBe('Ann');
    app.click('#jam-open');
    expect(app.dialog()!.id).toBe('jam-dialog');
    expect(visible('#jam-start')).toBe(true);
    app.click('#jam-host');
    expect(app.status()).toBe('Jam started.');
    expect(info()).toBe('The jam is on. Invite people with a link, one link per person.');
    expect(visible('#jam-hosting')).toBe(true);
    expect(input('#jam-name').disabled).toBe(true);
    expect(app.$('#jam-open').getAttribute('aria-pressed')).toBe('true');
    // Starting again while hosting does nothing.
    app.click('#jam-host');
    expect(app.status()).toBe('Jam started.');

    app.click('#jam-invite');
    expect(info()).toBe('Making an invite…');
    await vi.waitFor(() => expect(visible('#jam-invite-box')).toBe(true));
    app.click('#jam-invite-copy');
    await app.settle();
    expect(app.clipboard.at(-1)).toBe(input('#jam-invite-url').value);
    expect(info()).toBe('Invite copied.');
    // Connecting without an answer code waits for one.
    app.click('#jam-connect');
    expect(info()).toBe('Invite copied.');

    const offer = input('#jam-invite-url').value.split('#jam=')[1]!;
    const reply = await answerInvite(offer);
    input('#jam-answer').value = reply.answer;
    app.click('#jam-connect');
    expect(info()).toBe('Connecting…');
    const doc = remote();
    const guest = track(JamSession.join(doc, 'Bob', await reply.link));
    await vi.waitFor(() => expect(people()).toEqual(['Ann (you)', 'Bob']), 8000);
    expect(info()).toBe('Connected. Make another invite for the next person.');
    expect(input('#jam-invite-url').value).toBe('');
    expect(app.$('#jam-open').title).toBe('In a jam with Ann, Bob');
    // The guest got the host's song.
    expect(doc.current.channels).toBe(app.song().channels);

    // A note typed on the page reaches the guest.
    app.dialog()!.close();
    app.key('Space');
    app.key('KeyQ');
    await vi.waitFor(() => expect(readCell(doc.current, doc.current.patterns[0]!, 0, 0).note).toBe(61));
    // The guest's note and cursor show on the page.
    writeCell(doc.current, doc.current.patterns[0]!, 4, 2, { note: 61, instrument: 1 });
    guest.local({ kind: 'pattern', index: 0 });
    guest.cursor({ pattern: 0, row: 4, channel: 2 });
    await vi.waitFor(() => expect(app.cell(4, 2)).toMatch(/^C-5/));
    await vi.waitFor(() => expect(app.$('#pattern .c.peer').getAttribute('title')).toBe('Bob'));
    // The host's cursor reaches the guest.
    app.key('ArrowDown');
    await vi.waitFor(() => expect(guest.cursors.get(0)).toMatchObject({ row: 2 }));

    // Leaving with guests asks first, and Cancel keeps the jam.
    app.click('#jam-open');
    app.click('#jam-leave');
    await app.answer('Cancel');
    expect(app.$('#jam-open').getAttribute('aria-pressed')).toBe('true');
    app.click('#jam-leave');
    await app.answer('Leave');
    expect(app.status()).toBe('The jam is over. The song stays here.');
    expect(app.$('#jam-open').getAttribute('aria-pressed')).toBe('false');
    await vi.waitFor(() => expect(guest.active).toBe(false));
    expect(document.querySelector('#pattern .c.peer')).toBeNull();
  });

  it('says when a guest leaves, and leaves at once when alone', async () => {
    app = await bootApp();
    const { guest } = await hostWithGuest();
    await vi.waitFor(() => expect(people()).toEqual(['Anonymous (you)', 'Bob']));
    guest.leave();
    await vi.waitFor(() => expect(people()).toEqual(['Anonymous (you)']));
    app.click('#jam-leave');
    await app.settle();
    expect(app.status()).toBe('The jam is over. The song stays here.');
    expect(app.dialog()?.classList.contains('ask')).toBeFalsy();
  });

  it('says so when an invite cannot be made or connected', async () => {
    app = await bootApp();
    app.click('#jam-open');
    app.click('#jam-host');
    vi.stubGlobal('RTCPeerConnection', class {
      constructor() {
        throw new Error('no WebRTC');
      }
    });
    app.click('#jam-invite');
    await vi.waitFor(() => expect(info()).toBe('Could not make an invite: no WebRTC.'));
    installFakeRtc();
    app.click('#jam-invite');
    await vi.waitFor(() => expect(visible('#jam-invite-box')).toBe(true));
    input('#jam-answer').value = 'not an answer';
    app.click('#jam-connect');
    await vi.waitFor(() => expect(info()).toMatch(/^Could not connect: /));
  });

  it('opens the jam in another tab of this browser', async () => {
    app = await bootApp();
    app.click('#jam-open');
    // Without a jam the tab button does nothing.
    app.click('#jam-tab');
    expect(app.opened).toHaveLength(0);
    app.click('#jam-host');
    app.click('#jam-tab');
    const room = app.opened[0]!.url.split('#jam-tab=')[1]!;
    expect(room).toMatch(/^[a-z0-9]+$/);
    const doc = remote();
    const guest = track(JamSession.join(doc, 'Tab', joinInTab(room)));
    await vi.waitFor(() => expect(people()).toEqual(['Anonymous (you)', 'Tab']));
    expect(guest.active).toBe(true);
  });

  it('remembers the name, and leaves on pagehide', async () => {
    app = await bootApp();
    input('#jam-name').value = '  Cleo ';
    app.$('#jam-name').dispatchEvent(new Event('change'));
    expect(localStorage.getItem('webtracker.jamName')).toBe('Cleo');
    const { guest } = await hostWithGuest();
    expect(people()[0]).toBe('Cleo (you)');
    dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(guest.active).toBe(false));
    expect(app.status()).toBe('The jam is over. The song stays here.');
  });
});

describe('joining a jam', () => {
  it('opens from an invite link, makes an answer code and gets the song', async () => {
    const hostDoc = remote();
    hostDoc.current.title = 'Shared';
    writeCell(hostDoc.current, hostDoc.current.patterns[0]!, 0, 1, { note: 50, instrument: 1 });
    const host = track(JamSession.host(hostDoc, 'Ann'));
    const invite = await createInvite();
    app = await bootApp({ hash: `#jam=${invite.offer}` });
    expect(location.hash).toBe('');
    expect(app.dialog()!.id).toBe('jam-dialog');
    expect(visible('#jam-joining')).toBe(true);
    expect(visible('#jam-start')).toBe(false);
    app.click('#jam-join');
    await vi.waitFor(() => expect(input('#jam-answer-out').value).not.toBe(''));
    expect(visible('#jam-answer-box')).toBe(true);
    expect(visible('#jam-join')).toBe(false);
    app.click('#jam-answer-copy');
    await app.settle();
    expect(app.clipboard.at(-1)).toBe(input('#jam-answer-out').value);
    expect(info()).toBe('Answer code copied.');

    host.addGuest(await invite.accept(input('#jam-answer-out').value));
    await vi.waitFor(() => expect(app.status()).toBe('You joined the jam: Ann, Anonymous.'));
    expect(info()).toBe('You are in. Edits show up for everyone as you make them.');
    expect(app.$<HTMLInputElement>('#title').value).toBe('Shared');
    expect(app.cell(0, 1)).toMatch(/^C#4/);
    expect(people()).toEqual(['Ann (host)', 'Anonymous (you)']);

    // The host ending the jam leaves the guest with the song.
    host.leave();
    await vi.waitFor(() => expect(app.status()).toBe('The host left the jam. The song stays here.'));
    expect(app.$<HTMLInputElement>('#title').value).toBe('Shared');
  });

  it('joins a tab of this browser straight away', async () => {
    const hostDoc = remote();
    const host = track(JamSession.host(hostDoc, 'Ann'));
    const stop = listenInTabs('room1', (link: Link) => host.addGuest(link));
    app = await bootApp({ hash: '#jam-tab=room1' });
    await vi.waitFor(() => expect(app.status()).toBe('You joined the jam: Ann, Anonymous.'));
    expect(input('#jam-answer-out').value).toBe('');
    // A second invite while in a jam is turned away.
    location.hash = '#jam-tab=room2';
    dispatchEvent(new HashChangeEvent('hashchange'));
    await app.settle();
    // Leaving as a guest needs no question.
    app.click('#jam-leave');
    await app.settle();
    expect(app.status()).toBe('You left the jam. The song stays here.');
    stop();
  });

  it('says why an invite does not work, and can be put aside', async () => {
    app = await bootApp({ hash: '#jam=garbage' });
    app.click('#jam-join');
    await vi.waitFor(() => expect(info()).toMatch(/^Could not join: /));
    expect(visible('#jam-join')).toBe(true);
    app.click('#jam-leave');
    await app.settle();
    expect(visible('#jam-start')).toBe(true);
    expect(visible('#jam-joining')).toBe(false);
  });
});

describe('sending everything to another browser', () => {
  it('makes a transfer link, sends the backup and reports the receipt', async () => {
    app = await bootApp({ storage: { 'webtracker.jamName': 'Ann' } });
    app.click('#transfer-open');
    expect(app.dialog()!.id).toBe('transfer-dialog');
    expect(visible('#transfer-start')).toBe(true);
    app.click('#transfer-send');
    await vi.waitFor(() => expect(input('#transfer-url').value).toMatch(/#transfer=/));
    expect(visible('#transfer-sending')).toBe(true);
    app.click('#transfer-copy');
    await app.settle();
    expect(app.$('#transfer-info').textContent).toBe('Link copied.');
    // Nothing to connect without an answer code.
    app.click('#transfer-connect');
    expect(app.$('#transfer-info').textContent).toBe('Link copied.');

    const reply = await answerInvite(input('#transfer-url').value.split('#transfer=')[1]!);
    input('#transfer-answer').value = reply.answer;
    app.click('#transfer-connect');
    const link = await reply.link;
    const received: Uint8Array[] = [];
    link.onMessage = (bytes) => received.push(bytes);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(app.$('#transfer-info').textContent).toBe('Sending 1 song…');
    const names = unzipAll(received[0]!).map((e) => e.name);
    expect(names).toContain(SETTINGS_FILE);
    link.send(new TextEncoder().encode(JSON.stringify({ added: 2, skipped: 0 })));
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toBe('Sent 1 song and the settings. The other browser added 2 songs.'));
    expect(visible('#transfer-start')).toBe(true);
  });

  it('takes an empty receipt, and says when the other side goes away', async () => {
    app = await bootApp();
    const connect = async () => {
      app.click('#transfer-send');
      await vi.waitFor(() => expect(input('#transfer-url').value).toMatch(/#transfer=/));
      const reply = await answerInvite(input('#transfer-url').value.split('#transfer=')[1]!);
      input('#transfer-answer').value = reply.answer;
      app.click('#transfer-connect');
      const link = await reply.link;
      await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toMatch(/^Sending/));
      return link;
    };
    app.click('#transfer-open');
    let link = await connect();
    link.send(new Uint8Array([1]));
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toBe('Sent 1 song and the settings. The other browser added 0 songs.'));
    link = await connect();
    link.close();
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toBe('The other browser went away before the transfer was done.'));
    input('#transfer-answer').value = 'nonsense';
    app.click('#transfer-send');
    await vi.waitFor(() => expect(input('#transfer-url').value).toMatch(/#transfer=/));
    input('#transfer-answer').value = 'nonsense';
    app.click('#transfer-connect');
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toMatch(/^Could not connect: /));
  });

  it('says when no transfer link can be made', async () => {
    app = await bootApp();
    vi.stubGlobal('RTCPeerConnection', class {
      constructor() {
        throw new Error('no WebRTC');
      }
    });
    app.click('#transfer-open');
    app.click('#transfer-send');
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toBe('Could not make a transfer link: no WebRTC.'));
  });

  it('receives from a transfer link and sends back what it added', async () => {
    const invite = await createInvite();
    app = await bootApp({ hash: `#transfer=${invite.offer}` });
    expect(app.dialog()!.id).toBe('transfer-dialog');
    expect(visible('#transfer-receiving')).toBe(true);
    app.click('#transfer-accept');
    await vi.waitFor(() => expect(input('#transfer-answer-out').value).not.toBe(''));
    expect(visible('#transfer-accept')).toBe(false);
    app.click('#transfer-answer-copy');
    await app.settle();
    expect(app.$('#transfer-info').textContent).toBe('Answer code copied.');
    const link = await invite.accept(input('#transfer-answer-out').value);
    const receipts: unknown[] = [];
    link.onMessage = (bytes) => receipts.push(JSON.parse(new TextDecoder().decode(bytes)));
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toBe('Connected. Receiving…'));
    const song = { id: 1, name: 'Sent over', savedAt: 1, bytes: saveXm(createSong(4)) };
    link.send(createBackup([song], {}));
    await vi.waitFor(() => expect(receipts).toEqual([{ added: 1, skipped: 0 }]));
    expect(visible('#transfer-receiving')).toBe(false);
  });

  it('says why a transfer link does not work, and when the sender goes away', async () => {
    app = await bootApp({ hash: '#transfer=garbage' });
    app.click('#transfer-accept');
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toMatch(/^Could not receive: /));
    const invite = await createInvite();
    app = await bootApp({ hash: `#transfer=${invite.offer}` });
    app.click('#transfer-accept');
    await vi.waitFor(() => expect(input('#transfer-answer-out').value).not.toBe(''));
    const link = await invite.accept(input('#transfer-answer-out').value);
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toBe('Connected. Receiving…'));
    link.close();
    await vi.waitFor(() => expect(app.$('#transfer-info').textContent).toBe('The other browser went away before the transfer was done.'));
  });
});
