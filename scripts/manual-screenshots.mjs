/**
 * Takes the screenshots for the manual page from the built site:
 *
 *   pnpm build && pnpm screenshots:manual
 *
 * Opens the demo song through a share link in headless Chromium and writes
 * the pictures to packages/app/public/manual/. Retake them after UI changes.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveDist } from './serve-dist.mjs';
import { createDemoSong } from '../packages/engine/src/demo-song.ts';
import { saveXm } from '../packages/formats/src/xm-write.ts';
import { encodeShare } from '../packages/app/src/storage/share.ts';

const root = new URL('../packages/app/dist/', import.meta.url).pathname;
const out = process.argv[2] ?? new URL('../packages/app/public/manual/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const { base, server } = await serveDist(root);
const song = `${base}#song=${await encodeShare(saveXm(createDemoSong()))}`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

async function open(device, url = song) {
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`page error: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  return page;
}

const click = (page, selector) => page.evaluate((s) => document.querySelector(s).click(), selector);

/** Saves the page, or the box around the given elements (cut at maxHeight), as `name`.png. */
async function shot(page, name, selectors = [], maxHeight = Infinity) {
  const path = join(out, `${name}.png`);
  if (!selectors.length) return page.screenshot({ path });
  const boxes = await Promise.all(selectors.map((s) => page.locator(s).first().boundingBox()));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const width = Math.max(...boxes.map((b) => b.x + b.width)) - x;
  const height = Math.min(maxHeight, Math.max(...boxes.map((b) => b.y + b.height)) - y);
  return page.screenshot({ path, clip: { x, y, width, height } });
}

// Desktop: the whole screen while the song plays pattern 02.
{
  const page = await open(desktop);
  await page.locator('#orders > *').nth(2).click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await shot(page, 'desktop');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);

  for (const [view, instrument, height] of [['sample', 0, 320], ['instrument', 7, 318]]) {
    await page.locator('#instrument-list > *').nth(instrument).click();
    await click(page, `[data-view-target="${view}"]`);
    await page.waitForTimeout(300);
    await shot(page, view, ['.pattern-head', '#editors'], height);
  }
  await click(page, '[data-view-target="pattern"]');

  // Edit mode with a block selected, in a smaller window.
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.locator('#pattern').click({ position: { x: 40, y: 60 } });
  await page.keyboard.press('Space');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await shot(page, 'pattern', ['.pattern-panel'], 300);
  await page.keyboard.press('Space');
  await page.setViewportSize(desktop.viewport);

  for (const [name, button, dialog] of [
    ['save', '#save', '#file-dialog'],
    ['share', '#share-open', '#share-dialog'],
    ['jam', '#jam-open', '#jam-dialog'],
    ['setup', '#setup-open', '#setup'],
    ['help', '#help-open', '#help'],
  ]) {
    await click(page, button);
    await page.waitForTimeout(400);
    // The link points at the local test server; show the real address.
    await page.evaluate(() => {
      const url = document.querySelector('#share-url');
      url.value = url.value.replace(/^https?:\/\/[^/]+\//, 'https://chiptrackr.com/');
      document.querySelector('#jam-name').value = 'pixelpusher';
    });
    await shot(page, name, [dialog]);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await page.context().close();
}

// Phone: editor and piano, the entry pad, the menu and the pattern picker.
{
  const page = await open(phone);
  await shot(page, 'phone');
  await click(page, '#bar-rec');
  await page.waitForTimeout(300);
  await shot(page, 'phone-entry');
  await click(page, '#bar-rec');
  await click(page, '#bar-menu');
  await page.waitForTimeout(500);
  await shot(page, 'phone-menu');
  await page.context().close();
}

// The replayer page.
{
  const page = await open(desktop, `${base}replayer/`);
  await page.getByRole('button', { name: /play/i }).first().click();
  await page.waitForTimeout(3000);
  await shot(page, 'replayer', ['#player']);
  await page.context().close();
}

await browser.close();
server.close();
