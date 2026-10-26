/**
 * Browser smoke test of the built site in headless Chromium or Firefox:
 *
 *   pnpm build && pnpm smoke [screenshot-dir] [--firefox]
 *
 * Serves packages/app/dist and, at several screen sizes, checks that the
 * tracker loads without errors and without sideways scrolling, that the
 * AudioWorklet starts and playback runs and stops, and that the Help dialog opens. What's new
 * must stay shut on a first visit and open once after an update. On the desktop
 * size a note typed into the pattern must change the saved XM, and WAV and MP3 export must hand
 * over files. The replayer page must load and play its demo too, and a German browser must get
 * the German language pack (and a Finnish one the Finnish pack). Screenshots go to the given folder.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, firefox } from 'playwright';
import { serveDist } from './serve-dist.mjs';

const root = new URL('../packages/app/dist/', import.meta.url).pathname;
const useFirefox = process.argv.includes('--firefox');
const shots = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (shots) mkdirSync(shots, { recursive: true });

const { base, server } = await serveDist(root);

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'tablet', width: 820, height: 1180, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'phone-landscape', width: 844, height: 390, touch: true },
  { name: 'small-phone', width: 320, height: 568, touch: true },
];

const browser = useFirefox
  ? await firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } })
  : await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`browser: ${useFirefox ? 'Firefox' : 'Chromium'} ${browser.version()}`);
const failures = [];

async function open(url, viewport, locale = 'en-US') {
  const context = await browser.newContext({
    locale,
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: !!viewport.touch,
    // Firefox has no mobile emulation; touch and the small viewport still apply.
    ...(useFirefox ? {} : { isMobile: !!viewport.touch }),
    serviceWorkers: 'block',
  });
  // Without this, an action that never completes (such as a tap) waits forever.
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url, { waitUntil: 'load' });
  return { context, page, errors };
}

async function check(name, run) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const viewport of viewports) {
  await check(`tracker at ${viewport.name} ${viewport.width}x${viewport.height}`, async () => {
    const { context, page, errors } = await open(base, viewport);
    try {
      await page.waitForSelector('#pattern-no');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `page scrolls sideways by ${overflow}px`);

      // The bar button is shown at every size; the toolbar may be folded away on a phone.
      const plays = [];
      await page.exposeFunction('smokeTrack', (name) => plays.push(name));
      await page.evaluate(() => window.addEventListener('chiptrackr:track', (e) => window.smokeTrack(e.detail.name)));
      const play = page.locator('#bar-play');
      if (await play.isVisible()) await play.click();
      else await page.locator('#play-song').click({ force: true });
      await page.waitForTimeout(1500);
      assert(plays.includes('play'), 'Play did not start the song');
      assert(/Audio running/.test(await page.locator('#status').innerText()), 'the AudioWorklet did not start');
      assert((await play.getAttribute('aria-pressed')) === 'true', 'the replayer stopped on its own');
      if (shots) await page.screenshot({ path: join(shots, `${viewport.name}.png`) });
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.querySelector('#bar-play')?.click());
      await page.waitForTimeout(300);
      assert((await play.getAttribute('aria-pressed')) === 'false', 'Stop did not stop the song');

      await page.evaluate(() => document.querySelector('#help-open')?.click());
      assert(await page.locator('#help').evaluate((d) => d.open), 'Help did not open');
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });
}

async function downloadBytes(page, click, timeout = 10000) {
  const download = page.waitForEvent('download', { timeout });
  await page.evaluate(click);
  const file = await download;
  const failure = await file.failure();
  assert(!failure, `download failed: ${failure}`);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

await check('editing, saving and audio export', async () => {
  const { context, page, errors } = await open(base, viewports[0]);
  try {
    await page.waitForSelector('#pattern-no');
    const saveXm = () => document.querySelector('#save-xm')?.click();
    const before = await downloadBytes(page, saveXm);
    assert(before.bytes.subarray(0, 17).toString('latin1') === 'Extended Module: ', 'Save XM did not write an XM');

    await page.locator('#rec').click();
    assert((await page.locator('#rec').getAttribute('aria-pressed')) === 'true', 'edit mode did not switch on');
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('KeyW');
    await page.waitForTimeout(200);
    const after = await downloadBytes(page, saveXm);
    assert(!after.bytes.equals(before.bytes), 'typing notes in edit mode did not change the song');

    for (const [format, magic] of [['wav:pcm16', 'RIFF'], ['mp3:128', null]]) {
      await page.evaluate((value) => {
        const select = document.querySelector('#export-format');
        select.value = value;
        select.dispatchEvent(new Event('change'));
      }, format);
      const file = await downloadBytes(page, () => document.querySelector('#export-go')?.click(), 120000);
      assert(file.bytes.length > 10000, `${format} export is only ${file.bytes.length} bytes`);
      if (magic) assert(file.bytes.subarray(0, 4).toString('latin1') === magic, `${format} export has a wrong header`);
      else assert(/\.mp3$/.test(file.name), `${format} export is called ${file.name}`);
    }
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

// Backing up the song library and restoring it in a browser that has none, on a phone.
// Backups and the transfer between browsers, on a phone. Each browser context
// starts with the demo song only.
const phone = viewports.find((v) => v.name === 'phone');

/** A fresh browser with one more song saved and a Jam name set. */
async function browserWithSong() {
  const opened = await open(base, phone);
  const { page } = opened;
  await page.waitForSelector('#pattern-no');
  await page.evaluate(() => document.querySelector('#songs-open')?.click());
  await page.locator('#library-list li[aria-selected]').first().waitFor();
  await page.evaluate(() => document.querySelector('#library-save')?.click());
  await page.waitForFunction(() => document.querySelectorAll('#library-list li').length >= 2);
  await page.evaluate(() => {
    localStorage.setItem('webtracker.jamName', 'smoke');
    document.querySelector('#songs-dialog')?.close();
  });
  return opened;
}

const songCount = (page) => page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open('webtracker');
  open.onsuccess = () => {
    const request = open.result.transaction('songs').objectStore('songs').count();
    request.onsuccess = () => resolve(request.result);
  };
}));

await check('backups: songs in Songs, everything in Setup', async () => {
  let songs;
  let everything;
  {
    const { context, page, errors } = await browserWithSong();
    try {
      songs = await downloadBytes(page, () => document.querySelector('#library-backup')?.click());
      assert(/^chiptrackr-songs-.*\.zip$/.test(songs.name), `songs backup is called ${songs.name}`);
      assert(songs.bytes.subarray(0, 4).toString('latin1') === 'PK\x03\x04', 'songs backup is not a ZIP');
      assert(!songs.bytes.includes('chiptrackr-settings.json'), 'the songs backup holds settings');
      everything = await downloadBytes(page, () => document.querySelector('#backup-all')?.click());
      assert(/^chiptrackr-backup-.*\.zip$/.test(everything.name), `full backup is called ${everything.name}`);
      assert(everything.bytes.includes('chiptrackr-settings.json'), 'the full backup has no settings');
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
  const { context, page, errors } = await open(base, phone);
  try {
    await page.waitForSelector('#pattern-no');
    await page.evaluate(() => document.querySelector('#songs-open')?.click());
    await page.locator('#library-list li').first().waitFor();
    await page.locator('#library-restore-file').setInputFiles({ name: songs.name, mimeType: 'application/zip', buffer: songs.bytes });
    await page.waitForFunction(() => document.querySelectorAll('#library-list li').length >= 2);
    const info = await page.locator('#library-info').innerText();
    assert(/Added 1 song/.test(info) && /Already here: 1 song/.test(info), `restore said: ${info}`);
    // Restoring everything (from Setup) offers the settings; keep this browser's first.
    await page.evaluate(() => document.querySelector('#songs-dialog')?.close());
    await page.locator('#backup-file').setInputFiles({ name: everything.name, mimeType: 'application/zip', buffer: everything.bytes });
    await page.getByRole('button', { name: 'Keep mine' }).click();
    assert((await page.evaluate(() => localStorage.getItem('webtracker.jamName'))) === null, 'Keep mine took the settings anyway');
    await page.locator('#backup-file').setInputFiles({ name: everything.name, mimeType: 'application/zip', buffer: everything.bytes });
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Replace and reload' }).click()]);
    assert((await page.evaluate(() => localStorage.getItem('webtracker.jamName'))) === 'smoke', 'the settings were not restored');
    assert((await songCount(page)) === 2, 'restoring twice added songs twice');
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

await check('sending everything to another browser', async () => {
  const sender = await browserWithSong();
  const receiver = await open(base, phone);
  try {
    const { page: from } = sender;
    await from.evaluate(() => document.querySelector('#transfer-open')?.click());
    await from.locator('#transfer-send').click();
    await from.waitForFunction(() => document.querySelector('#transfer-url')?.value.includes('#transfer='), null, { timeout: 20000 });
    const link = await from.locator('#transfer-url').inputValue();

    const { page: to } = receiver;
    await to.goto(link, { waitUntil: 'load' });
    await to.locator('#transfer-accept').click();
    await to.waitForFunction(() => document.querySelector('#transfer-answer-out')?.value, null, { timeout: 20000 });
    const answer = await to.locator('#transfer-answer-out').inputValue();

    await from.locator('#transfer-answer').fill(answer);
    await from.locator('#transfer-connect').click();
    await from.waitForFunction(() => /added/.test(document.querySelector('#transfer-info')?.textContent ?? ''), null, { timeout: 20000 });
    const sent = await from.locator('#transfer-info').innerText();
    assert(/Sent 2 songs/.test(sent) && /added 1 song/.test(sent), `sender said: ${sent}`);
    await Promise.all([to.waitForEvent('load'), to.getByRole('button', { name: 'Replace and reload' }).click()]);
    assert((await songCount(to)) === 2, 'the receiver did not get the song');
    assert((await to.evaluate(() => localStorage.getItem('webtracker.jamName'))) === 'smoke', 'the receiver did not get the settings');
    for (const { errors } of [sender, receiver]) assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await sender.context.close();
    await receiver.context.close();
  }
});

await check('replayer page plays its demo', async () => {
  const { context, page, errors } = await open(`${base}replayer/`, viewports[0]);
  try {
    const button = page.getByRole('button', { name: /play/i }).first();
    await button.click();
    await page.waitForTimeout(1500);
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    if (shots) await page.screenshot({ path: join(shots, 'replayer.png') });
  } finally {
    await context.close();
  }
});

// What's new stays shut on a first visit, opens once after an update, and opens from Help.
await check("What's new after an update", async () => {
  const { context, page, errors } = await open(base, phone);
  try {
    await page.waitForSelector('#pattern-no');
    await page.waitForFunction(() => localStorage.getItem('webtracker.whatsNew'));
    assert(!(await page.evaluate(() => document.querySelector('#whats-new').open)), 'it opened on a first visit');
    // An older release seen last time: the next visit shows what is new.
    await page.evaluate(() => localStorage.setItem('webtracker.whatsNew', '2000-01-01'));
    await page.reload({ waitUntil: 'load' });
    await page.locator('#whats-new[open] .whats-new-list li').first().waitFor();
    if (shots) await page.screenshot({ path: join(shots, 'whats-new-phone.png') });
    await page.locator('#whats-new button[type=submit]').click();
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#pattern-no');
    await page.waitForTimeout(500);
    assert(!(await page.evaluate(() => document.querySelector('#whats-new').open)), 'it opened again after being closed');
    await page.evaluate(() => document.querySelector('#help-open').click());
    await page.locator('#whats-new-open').click();
    await page.locator('#whats-new[open]').waitFor();
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

// A browser set to German gets the German pack: the page, its dialogs and the manual.
await check('German language pack', async () => {
  for (const viewport of [viewports[0], viewports[3]]) {
    const { context, page, errors } = await open(base, viewport, 'de-DE');
    try {
      await page.waitForSelector('#pattern-no');
      const shown = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        save: document.querySelector('#save').textContent,
        status: document.querySelector('#status').textContent,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }));
      assert(shown.lang === 'de', `page language is ${shown.lang}`);
      assert(shown.save === 'Speichern' && /Taste/.test(shown.status), `not translated: ${shown.save} / ${shown.status}`);
      assert(shown.overflow <= 1, `page scrolls sideways by ${shown.overflow}px at ${viewport.name}`);
      if (viewport === viewports[0]) {
        await page.click('#help-open');
        assert((await page.textContent('.help-tabs')).includes('Tasten'), 'Help is not translated');
        if (shots) await page.screenshot({ path: join(shots, 'german-help.png') });
        await page.goto(`${base}manual.html`);
        await page.waitForSelector('#start');
        assert((await page.textContent('#start h2')) === 'Erste Schritte', 'manual is not translated');
      } else if (shots) await page.screenshot({ path: join(shots, 'german-phone.png') });
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
});

// Finnish has the longest words of the packs: it must fit at desktop and phone size too.
await check('Finnish language pack', async () => {
  for (const viewport of [viewports[0], viewports[3]]) {
    const { context, page, errors } = await open(base, viewport, 'fi-FI');
    try {
      await page.waitForSelector('#pattern-no');
      const shown = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        save: document.querySelector('#save').textContent,
        status: document.querySelector('#status').textContent,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }));
      assert(shown.lang === 'fi', `page language is ${shown.lang}`);
      assert(shown.save === 'Tallenna' && /näppäin/.test(shown.status), `not translated: ${shown.save} / ${shown.status}`);
      assert(shown.overflow <= 1, `page scrolls sideways by ${shown.overflow}px at ${viewport.name}`);
      if (shots) await page.screenshot({ path: join(shots, `finnish-${viewport.name}.png`) });
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
});

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
