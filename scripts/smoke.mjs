/**
 * Browser smoke test of the built site in headless Chromium:
 *
 *   pnpm build && pnpm smoke [screenshot-dir]
 *
 * Serves packages/app/dist and, at several screen sizes, checks that the
 * tracker loads without errors and without sideways scrolling, that the
 * AudioWorklet starts and playback runs and stops, and that the Help dialog opens. The replayer page
 * must load and play its demo too. Screenshots go to the given folder.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('../packages/app/dist/', import.meta.url).pathname;
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.xm': 'application/octet-stream',
};

const server = createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (path.endsWith('/')) path += 'index.html';
  const file = join(root, path);
  try {
    if (!file.startsWith(root) || !statSync(file).isFile()) throw new Error();
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'tablet', width: 820, height: 1180, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'phone-landscape', width: 844, height: 390, touch: true },
  { name: 'small-phone', width: 320, height: 568, touch: true },
];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const failures = [];

async function open(url, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: !!viewport.touch,
    isMobile: !!viewport.touch,
    serviceWorkers: 'block',
  });
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

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
