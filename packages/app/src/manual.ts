// The manual page: the chapters from manual-content.ts, then the whole Help
// reference, in the colours chosen in Setup.

import '@fontsource/press-start-2p/400.css';
import './style.css';
import { HELP_SECTIONS, type HelpEntry, type HelpGroup } from './ui/help-content.ts';
import { MANUAL_CHAPTERS, type ManualBlock, type ManualChapter, type ManualFigure } from './ui/manual-content.ts';
import { loadSettings } from './ui/settings.ts';

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
/** Escapes text, shows `backticked` parts as keys and [text](href) as links. */
const inline = (s: string) =>
  escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

function blockHtml(block: ManualBlock): string {
  if (typeof block === 'string') return `<p>${inline(block)}</p>`;
  if ('list' in block) return `<ul>${block.list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`;
  if ('steps' in block) return `<ol>${block.steps.map((li) => `<li>${inline(li)}</li>`).join('')}</ol>`;
  return `<p class="manual-tip">${inline(block.tip)}</p>`;
}

/** A screenshot, linked to the full-size file. */
function figureHtml(figure: ManualFigure): string {
  const src = `./manual/${figure.file}`;
  const img = `<img src="${src}" width="${figure.width}" height="${figure.height}" alt="${escape(figure.alt)}" loading="lazy" decoding="async" />`;
  const caption = figure.caption ? `<figcaption>${inline(figure.caption)}</figcaption>` : '';
  return `<figure class="manual-figure"><a href="${src}" target="_blank" rel="noopener">${img}</a>${caption}</figure>`;
}

/** Wide screenshots above the text, the others in a column beside it (below the heading on narrow screens). */
function chapterHtml(chapter: ManualChapter): string {
  const figures = chapter.figures ?? [];
  const wide = figures.filter((f) => f.wide);
  const side = figures.filter((f) => !f.wide);
  const text = `<div class="manual-text">${chapter.blocks.map(blockHtml).join('')}</div>`;
  const aside = side.length ? `<div class="manual-side${side.length > 2 ? ' manual-row' : ''}">${side.map(figureHtml).join('')}</div>` : '';
  return (
    `<section id="${chapter.id}"><h2 class="ptitle">${escape(chapter.title)}</h2>` +
    wide.map(figureHtml).join('') +
    `<div class="manual-cols${aside ? ' has-side' : ''}">${aside}${text}</div></section>`
  );
}

function entryHtml(entry: HelpEntry): string {
  const name = entry.name ? `<b>${escape(entry.name)}</b> ` : '';
  const link = entry.link ? ` <a href="${escape(entry.link.href)}" target="_blank" rel="noopener">${escape(entry.link.label)}</a>` : '';
  const id = entry.id ? ` id="${entry.id}"` : '';
  return `<div class="help-entry"${id}><span class="help-code">${escape(entry.code)}</span><span>${name}${escape(entry.text)}${link}</span></div>`;
}

function groupHtml(group: HelpGroup): string {
  const title = group.title ? `<h4>${escape(group.title)}</h4>` : '';
  const intro = group.intro ? `<p class="help-intro">${escape(group.intro)}</p>` : '';
  const list = group.entries.length ? `<div class="help-list">${group.entries.map(entryHtml).join('')}</div>` : '';
  return `<div class="help-group">${title}${intro}${list}</div>`;
}

// Same colours as the tracker.
const prefs = loadSettings();
document.documentElement.dataset.theme = prefs.theme;
for (const [name, value] of Object.entries(prefs.colors)) document.documentElement.style.setProperty(name, value);
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--desk').trim());

const reference = HELP_SECTIONS.filter((s) => s.id !== 'workflow');
const toc = [
  ...MANUAL_CHAPTERS.map((c) => ({ id: c.id, title: c.title })),
  ...reference.map((s) => ({
    id: `ref-${s.id}`,
    title: `Reference: ${s.title}`,
  })),
];
document.getElementById('manual-toc')!.innerHTML = toc.map((t) => `<li><a href="#${t.id}">${escape(t.title)}</a></li>`).join('');
document.getElementById('manual-body')!.innerHTML = [
  ...MANUAL_CHAPTERS.map(chapterHtml),
  ...reference.map((s) => `<section id="ref-${s.id}" class="manual-ref"><h2 class="ptitle">Reference: ${escape(s.title)}</h2>${s.groups.map(groupHtml).join('')}</section>`),
].join('');

// The content is built after load, so jump to the anchor the link asked for now.
if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
