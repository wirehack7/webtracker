import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from '../ui/help-content.ts';
import { MANUAL_CHAPTERS } from '../ui/manual-content.ts';
import { LANGUAGES, normalize, resolveLanguage, t, tNodes, TEXT_ATTRIBUTES, useMessages, type Messages } from './i18n.ts';

const APP = new URL('../../', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
const decode = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|#39);/g, (_, e: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" })[e]!);
const hasWords = (s: string) => /[A-Za-z]{2,}/.test(s);

/** Texts passed to t(), tNodes() or msg() as string literals. */
function codeKeys(): string[] {
  const keys: string[] = [];
  for (const file of sourceFiles(join(APP, 'src'))) {
    if (file.includes(`${join('src', 'i18n')}/`) && !file.endsWith('edit-names.ts')) continue;
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\b(?:t|msg|tNodes)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) keys.push(unescape(m[1] ?? m[2]!));
  }
  return keys;
}

/** Texts in an HTML page that translatePage() looks up, found the way it finds them. */
function pageKeys(file: string): string[] {
  let html = readFileSync(join(APP, file), 'utf8');
  html = html.replace(/<head>[\s\S]*?<\/head>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|svg)\b[\s\S]*?<\/\1>/g, '');
  html = html.replace(/<(\w+)\b[^>]*\btranslate="no"[^>]*>[\s\S]*?<\/\1>/g, '');
  const keys: string[] = [];
  for (const m of html.matchAll(/>([^<]+)</g)) keys.push(normalize(decode(m[1]!)));
  for (const m of html.matchAll(new RegExp(`\\s(?:${TEXT_ATTRIBUTES.join('|')})="([^"]*)"`, 'g'))) keys.push(normalize(decode(m[1]!)));
  return keys.filter(hasWords);
}

/** Help and manual texts, which are translated where they are shown. */
function contentKeys(): { required: string[]; optional: string[] } {
  const required: string[] = [];
  // Codes and effect names are mostly keys and jargon; a pack translates them only where it wants to.
  const optional: string[] = [];
  for (const section of HELP_SECTIONS) {
    required.push(section.title);
    for (const group of section.groups) {
      if (group.title) required.push(group.title);
      if (group.intro) required.push(group.intro);
      for (const entry of group.entries) {
        required.push(entry.text);
        optional.push(entry.code);
        if (entry.name) optional.push(entry.name);
        if (entry.link) required.push(entry.link.label);
      }
    }
  }
  for (const chapter of MANUAL_CHAPTERS) {
    required.push(chapter.title);
    for (const figure of chapter.figures ?? []) required.push(figure.alt, ...(figure.caption ? [figure.caption] : []));
    for (const block of chapter.blocks) {
      if (typeof block === 'string') required.push(block);
      else if ('list' in block) required.push(...block.list);
      else if ('steps' in block) required.push(...block.steps);
      else required.push(block.tip);
    }
  }
  return { required, optional };
}

const content = contentKeys();
const required = new Set([...codeKeys(), ...pageKeys('index.html'), ...pageKeys('manual.html'), ...content.required]);
const known = new Set([...required, ...content.optional]);

/**
 * What a translation must keep: its placeholders and link targets as they are,
 * and as many `key` marks (their text may change with a translated button name).
 */
const fixed = (text: string) => [
  ...[...text.matchAll(/\{\w+\}|\]\([^)]+\)/g)].map((m) => m[0]).sort(),
  `${(text.match(/`/g) ?? []).length} backticks`,
];

describe('t', () => {
  it('fills placeholders and falls back to English', () => {
    useMessages('de', { 'Saved {file}.': '{file} gespeichert.' });
    expect(t('Saved {file}.', { file: 'a.xm' })).toBe('a.xm gespeichert.');
    expect(t('Not in the pack {n}', { n: 3 })).toBe('Not in the pack 3');
    expect(t('Keeps {unknown}', {})).toBe('Keeps {unknown}');
    useMessages('en', {});
  });

  it('puts nodes into a sentence', () => {
    useMessages('de', { 'The code is on {site}.': 'Der Code liegt auf {site}.' });
    const site = { nodeName: 'A' } as unknown as Node;
    expect(tNodes('The code is on {site}.', { site })).toEqual(['Der Code liegt auf ', site, '.']);
    useMessages('en', {});
  });
});

describe('resolveLanguage', () => {
  it('takes the choice from Setup', () => {
    expect(resolveLanguage('de', ['en-US'])).toBe('de');
    expect(resolveLanguage('en', ['de-DE'])).toBe('en');
  });

  it('follows the browser on auto, by region or base language', () => {
    expect(resolveLanguage('auto', ['de-AT', 'en'])).toBe('de');
    expect(resolveLanguage('auto', ['fr-FR', 'de'])).toBe('de');
    expect(resolveLanguage('auto', ['fr-FR', 'ja'])).toBe('en');
    expect(resolveLanguage('auto', [])).toBe('en');
  });

  it('falls back to auto for a language that was removed', () => {
    expect(resolveLanguage('xx', ['de'])).toBe('de');
  });
});

describe('language packs', () => {
  it('finds the texts to translate', () => {
    // Guards the extraction itself: a broken regular expression would make every pack look complete.
    expect(required.size).toBeGreaterThan(700);
    expect(required).toContain('Play Song');
    expect(required).toContain('Saved {file} ({bytes} bytes).');
    expect(required).toContain('Getting started');
  });

  for (const [code, language] of Object.entries(LANGUAGES)) {
    if (!language.load) continue;
    describe(`${language.name} (${code})`, async () => {
      const pack: Messages = (await language.load!()).default;

      it('translates every text', () => {
        const missing = [...required].filter((key) => !(key in pack));
        expect(missing, 'texts without a translation').toEqual([]);
      });

      it('has no texts the app no longer uses', () => {
        const stale = Object.keys(pack).filter((key) => !known.has(key));
        expect(stale, 'translations of texts that are gone').toEqual([]);
      });

      it('keeps placeholders, link targets and `key` marks', () => {
        const broken = Object.entries(pack).filter(([key, value]) => fixed(key).join('\n') !== fixed(value).join('\n'));
        expect(broken).toEqual([]);
      });
    });
  }
});
