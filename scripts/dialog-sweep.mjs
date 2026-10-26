/**
 * Dialog check of the built site in headless Chromium:
 *
 *   pnpm build && pnpm smoke:dialogs [screenshot-dir]
 *
 * Opens every dialog on phone screens (320 to 639 px wide, and a phone on its side) and on a
 * touch tablet, in English, German and Finnish, and fails when a dialog or anything in it runs
 * past the screen or its edge, scrolls sideways, or when a button, field or checkbox row is
 * smaller than a thumb, or when the Help head loses Close from its title row or its topic tabs
 * scroll sideways. A select whose chosen text does not fit only gets a note, since it ends
 * in an ellipsis and the full text shows when it opens. Screenshots of the 320 and 390 px phones
 * go to the given folder.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveDist } from './serve-dist.mjs';

const root = new URL('../packages/app/dist/', import.meta.url).pathname;
const shots = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (shots) mkdirSync(shots, { recursive: true });

const { base, server } = await serveDist(root);
const browser = await chromium.launch();
console.log(`browser: Chromium ${browser.version()}`);

const dialogs = ['setup', 'edit-tools', 'file-dialog', 'songs-dialog', 'share-dialog', 'jam-dialog', 'transfer-dialog', 'ins-picker', 'sample-library', 'pat-picker', 'whats-new', 'about', 'help'];
const screens = [320, 360, 375, 390, 414, 480, 560, 639].map((width) => ({ width, height: 740 }));
screens.push({ width: 844, height: 390 }, { width: 1024, height: 768 });
// Below this a tap target is too small for a thumb (CSS pixels).
const minTarget = 24;

let failures = 0;
let notes = 0;
for (const locale of ['en-US', 'de-DE', 'fi-FI']) {
  for (const screen of screens) {
    const context = await browser.newContext({ locale, viewport: screen, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.lang !== '' && document.fonts.status === 'loaded');
    for (const id of dialogs) {
      const { problems, hints } = await page.evaluate(
        ([id, minTarget]) => {
          for (const open of document.querySelectorAll('dialog[open]')) open.close();
          const dialog = document.getElementById(id);
          // Setup fills in its values when its button opens it.
          if (id === 'setup') document.getElementById('setup-open').click();
          // What's new fills in its list when it opens.
          if (id === 'whats-new') document.getElementById('whats-new-open').click();
          if (!dialog.open) dialog.showModal();
          // Every collapsible part open, so its contents are checked too.
          for (const details of dialog.querySelectorAll('details')) details.open = true;
          const problems = [];
          const hints = [];
          const box = dialog.getBoundingClientRect();
          if (box.left < 0 || box.right > innerWidth + 0.5 || box.top < 0 || box.bottom > innerHeight + 0.5) {
            problems.push(`dialog at ${box.left | 0},${box.top | 0}..${box.right | 0},${box.bottom | 0} is not on the ${innerWidth}x${innerHeight} screen`);
          }
          if (dialog.scrollWidth > dialog.clientWidth + 1) problems.push(`dialog scrolls sideways (${dialog.scrollWidth} > ${dialog.clientWidth})`);
          const style = getComputedStyle(dialog);
          const left = box.left + parseFloat(style.paddingLeft) - 1;
          const right = box.right - parseFloat(style.paddingRight) + 1;
          const measure = document.createElement('canvas').getContext('2d');
          const parts = dialog.querySelectorAll('select, input, button, .btn, .label, p, h2, h3, summary, .list, .range-field > span, .colour-grid label');
          for (const part of parts) {
            if (part.getClientRects().length === 0) continue;
            // Items inside scrolling lists may run on; the list itself may not.
            if (part.parentElement.closest('.list, .help-body')) continue;
            const r = part.getBoundingClientRect();
            const name = `${part.tagName.toLowerCase()} ${part.id || part.textContent.trim().slice(0, 24)}`;
            if (r.left < left || r.right > right) problems.push(`${name} at ${r.left | 0}..${r.right | 0}, outside ${left | 0}..${right | 0}`);
            if (['P', 'H2', 'H3', 'SPAN', 'BUTTON', 'A'].includes(part.tagName) && part.scrollWidth > part.clientWidth + 1) {
              problems.push(`${name} is cut off`);
            }
            const label = part.type === 'checkbox' ? part.closest('label') : null;
            const target = label && label.getClientRects().length ? label : part;
            if ((part.matches('button, .btn, select, input:not([type=range])')) && target.getBoundingClientRect().height < minTarget) {
              problems.push(`${name} is ${target.getBoundingClientRect().height | 0} px high`);
            }
            if (part.tagName === 'SELECT' && part.selectedOptions[0]) {
              const s = getComputedStyle(part);
              measure.font = `${s.fontSize} ${s.fontFamily}`;
              const need = measure.measureText(part.selectedOptions[0].text).width + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) + 12;
              if (need > r.width + 1) hints.push(`${name} shows "${part.selectedOptions[0].text}" shortened`);
            }
          }
          // The Help head keeps Close on the title's row, and its topic tabs never scroll sideways.
          if (id === 'help') {
            const title = dialog.querySelector('.help-head .ptitle').getBoundingClientRect();
            const close = dialog.querySelector('.help-close .btn').getBoundingClientRect();
            if (close.top >= title.bottom || close.bottom <= title.top) problems.push('Close is not on the title row');
            const tabs = dialog.querySelector('.help-tabs');
            if (tabs.scrollWidth > tabs.clientWidth + 1) problems.push(`help tabs scroll sideways (${tabs.scrollWidth} > ${tabs.clientWidth})`);
          }
          return { problems, hints };
        },
        [id, minTarget],
      );
      const where = `${locale} ${screen.width}x${screen.height} #${id}`;
      for (const p of new Set(problems)) console.log(`FAIL ${where}: ${p}`);
      for (const h of new Set(hints)) console.log(`note ${where}: ${h}`);
      failures += new Set(problems).size;
      notes += new Set(hints).size;
      if (shots && (screen.width === 320 || screen.width === 390)) {
        await page.screenshot({ path: join(shots, `${locale}-${screen.width}-${id}.png`) });
      }
    }
    await context.close();
  }
}

await browser.close();
server.close();
console.log(`${failures} problems, ${notes} notes`);
process.exit(failures ? 1 : 0);
