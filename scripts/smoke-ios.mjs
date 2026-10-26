/**
 * Smoke test of the built site in WebKit, emulating an iPhone:
 *
 *   pnpm build && pnpm smoke:ios [screenshot-dir]
 *
 * Needs Playwright's WebKit (`pnpm exec playwright install --with-deps webkit`).
 * `--chromium` runs the same checks in Chromium with the iPhone's user agent,
 * for machines without WebKit.
 *
 * WebKit is the engine of every iOS browser, but Playwright's WebKit is a Linux
 * build: it cannot show the iOS file picker, the ring/silent switch or the iOS
 * audio session. So this checks what can be checked from the page: that the file
 * inputs carry no type filter for iOS to grey files out with, that picked files
 * load or fail with a dialog, that taps start audio and play, that downloads
 * start, that IndexedDB keeps the song library, and that the replayer page plays.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, webkit } from 'playwright';
import { serveDist } from './serve-dist.mjs';

const root = new URL('../packages/app/dist/', import.meta.url).pathname;
const args = process.argv.slice(2);
const useChromium = args.includes('--chromium');
const shots = args.find((a) => !a.startsWith('--'));
if (shots) mkdirSync(shots, { recursive: true });

const { base, server } = await serveDist(root);
const browser = await (useChromium ? chromium : webkit).launch();
const phones = [devices['iPhone 15'], devices['iPhone SE'], devices['iPad Mini']];
const failures = [];

/** Rejects when `promise` takes longer than `ms`: a hung WebKit call must fail, not stall CI. */
function within(ms, promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function check(name, run) {
  try {
    await within(60000, run(), name);
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function open(url, device) {
  const { defaultBrowserType, ...options } = device;
  // Chromium has no isMobile emulation of Safari, only its viewport and user agent.
  if (useChromium) delete options.isMobile;
  const context = await browser.newContext({ ...options, serviceWorkers: 'block', acceptDownloads: true });
  // Without this, an action that never completes (such as a tap) waits forever.
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url, { waitUntil: 'load' });
  return { context, page, errors };
}

/** A four-channel ProTracker module: one pattern with a note on a short square wave. */
function tinyMod() {
  const bytes = new Uint8Array(1084 + 1024 + 32);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('smoke test'), 0);
  // Sample 1: 16 words long, volume 64, loops over all of it.
  view.setUint16(20 + 22, 16);
  bytes[20 + 25] = 64;
  view.setUint16(20 + 28, 16);
  bytes[950] = 1; // song length
  bytes[951] = 127;
  bytes.set(new TextEncoder().encode('M.K.'), 1080);
  // Row 0, channel 0: period 428 (C-2), sample 1.
  view.setUint16(1084, 428);
  bytes[1086] = 0x10;
  for (let i = 0; i < 32; i++) bytes[2108 + i] = i < 16 ? 0x40 : 0xc0;
  return Buffer.from(bytes);
}

/** On a phone the toolbar sits in the sheet behind Menu. */
async function tapToolbar(page, id) {
  const menu = page.locator('#bar-menu');
  if ((await menu.isVisible()) && (await menu.getAttribute('aria-expanded')) !== 'true') await menu.tap();
  await page.locator(id).tap();
}

for (const device of phones) {
  const name = Object.keys(devices).find((key) => devices[key] === device);
  await check(`tracker on ${name}`, async () => {
    const { context, page, errors } = await open(base, device);
    try {
      await page.waitForSelector('#pattern-no');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `page scrolls sideways by ${overflow}px`);

      // iOS greys out every file whose type it cannot map from `accept`, which is all tracker formats.
      const filtered = await page.evaluate(() => [...document.querySelectorAll('input[type=file][accept]')].map((i) => i.id));
      assert(filtered.length === 0, `file inputs still filter by type: ${filtered.join(', ')}`);

      // Load opens the picker, and a picked .mod opens.
      const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
      await tapToolbar(page, '#load');
      await (await chooser).setFiles({ name: 'moontrip.mod', mimeType: '', buffer: tinyMod() });
      await page.waitForFunction(() => /moontrip\.mod: smoke test/.test(document.querySelector('#status')?.textContent ?? ''), null, { timeout: 5000 });

      // Anything else says why in a dialog, since the status bar is hidden on phones.
      await page.setInputFiles('#file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a module') });
      const dialog = page.locator('dialog.ask-dialog[open]');
      await dialog.waitFor({ timeout: 5000 });
      assert(/could not be opened/.test(await dialog.innerText()), 'the error dialog does not say what went wrong');
      await dialog.getByRole('button', { name: 'OK' }).tap();
      await dialog.waitFor({ state: 'detached', timeout: 5000 });

      // A sample picked in the sample importer lands in the instrument.
      await page.setInputFiles('#sample-file', { name: 'blip.raw', mimeType: '', buffer: Buffer.alloc(64, 0x40) });
      await page.waitForFunction(() => /blip\.raw: 64 frames/.test(document.querySelector('#status')?.textContent ?? ''), null, { timeout: 5000 });

      // A tap on Play starts the AudioWorklet and the song.
      const sheetOpen = await page.evaluate(() => document.querySelector('.app')?.classList.contains('sheet-open'));
      if (sheetOpen) await page.locator('#bar-menu').tap();
      const play = page.locator('#bar-play');
      const target = (await play.isVisible()) ? play : page.locator('#play-song');
      await target.tap();
      // Audio starts on the first finished tap, so its status line is long gone; Play only turns on with a running engine.
      const pressed = () => ['#bar-play', '#play-song'].some((id) => document.querySelector(id)?.getAttribute('aria-pressed') === 'true');
      await page.waitForFunction(pressed, null, { timeout: 8000 }).catch(async () => {
        throw new Error(`Play did not start the song; status: ${await page.locator('#status').textContent()}`);
      });
      if (shots) await page.screenshot({ path: join(shots, `${name.replace(/\W+/g, '-')}.png`) });
      await target.tap();

      // Saving hands the browser a download (on iOS, the Save to Files sheet).
      const download = page.waitForEvent('download', { timeout: 5000 });
      await page.evaluate(() => document.querySelector('#save-xm')?.click());
      const file = await download;
      assert(file.suggestedFilename().endsWith('.xm'), `saved as ${file.suggestedFilename()}`);

      // The song library lives in IndexedDB.
      const stores = await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('webtracker');
            request.onsuccess = () => resolve([...request.result.objectStoreNames]);
            request.onerror = () => reject(request.error);
          }),
      );
      assert(stores.includes('songs'), `IndexedDB has no song library: ${stores.join(', ')}`);

      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await within(10000, context.close(), 'closing the page');
    }
  });
}

await check('replayer page on iPhone 15', async () => {
  const { context, page, errors } = await open(`${base}replayer/`, devices['iPhone 15']);
  try {
    const filtered = await page.evaluate(() => [...document.querySelectorAll('input[type=file][accept]')].map((i) => i.id));
    assert(filtered.length === 0, `file inputs filter by type: ${filtered.join(', ')}`);
    await page.setInputFiles('#file', { name: 'moontrip.mod', mimeType: '', buffer: tinyMod() });
    await page.waitForFunction(() => /smoke test/.test(document.querySelector('#info')?.textContent ?? ''), null, { timeout: 5000 });
    await page.locator('#play').tap();
    await page.waitForFunction(() => document.querySelector('#play')?.textContent === 'Pause', null, { timeout: 8000 });
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    if (shots) await page.screenshot({ path: join(shots, 'replayer-iphone.png') });
  } finally {
    await within(10000, context.close(), 'closing the page');
  }
});

await within(10000, browser.close(), 'closing the browser').catch((e) => console.log(e.message));
server.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
process.exit(0);
