// Language packs. English is the source language: every text in the code and
// in the HTML pages is English and doubles as its own key, as with gettext. A
// language pack maps those English texts to its own; anything it leaves out
// shows in English. docs/TRANSLATING.md says how to add a language.

/** English text → translated text. `{name}` placeholders are filled by t(). */
export type Messages = Record<string, string>;

export interface Language {
  /** The language's own name for itself, as the Setup list shows it. */
  name: string;
  /** Loads the pack; English has none. */
  load?: () => Promise<{ default: Messages }>;
}

/** Every language the tracker offers, by BCP 47 code. */
export const LANGUAGES: Record<string, Language> = {
  en: { name: 'English' },
  de: { name: 'Deutsch', load: () => import('./de.ts') },
};

let messages: Messages = {};
let current = 'en';

/**
 * Translates an English text into the chosen language and fills its
 * placeholders: t('Saved {name}.', { name }). Keys must be plain string
 * literals so the coverage test can find them.
 */
export function t(text: string, params?: Record<string, string | number>): string {
  const translated = messages[text] ?? text;
  if (!params) return translated;
  return translated.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Marks a text for translation where it is defined; t() translates it where it is shown. */
export const msg = (text: string): string => text;

/** Like t(), with placeholders that take DOM nodes, such as links inside a sentence. */
export function tNodes(text: string, parts: Record<string, Node | string>): (Node | string)[] {
  return t(text)
    .split(/(\{\w+\})/)
    .filter(Boolean)
    .map((piece) => {
      const name = /^\{(\w+)\}$/.exec(piece)?.[1];
      return name && name in parts ? parts[name]! : piece;
    });
}

/** The language in use, e.g. 'de'. */
export function language(): string {
  return current;
}

/**
 * The language to show for a Setup choice: the chosen one, or for 'auto'
 * the first of the browser's languages there is a pack for, else English.
 */
export function resolveLanguage(choice: string, preferred: readonly string[]): string {
  if (choice !== 'auto' && choice in LANGUAGES) return choice;
  for (const tag of preferred) {
    const lang = tag.toLowerCase();
    if (lang in LANGUAGES) return lang;
    const base = lang.split('-')[0]!;
    if (base in LANGUAGES) return base;
  }
  return 'en';
}

/** Switches t() to a language; for tests and for the pages at start. */
export function useMessages(lang: string, pack: Messages): void {
  current = lang;
  messages = pack;
}

/** Loads the pack for a Setup choice and marks the page with its language. */
export async function initLanguage(choice: string): Promise<void> {
  const lang = resolveLanguage(choice, typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]);
  try {
    useMessages(lang, (await LANGUAGES[lang]?.load?.())?.default ?? {});
  } catch {
    // Offline before the pack was cached: English still works.
    useMessages('en', {});
  }
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

/** Attributes of the HTML pages that hold text to translate. */
export const TEXT_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'label'];

/** Whitespace-collapsed text, the form in which page texts are keys. */
export const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Translates the texts written in an HTML page: text nodes and the attributes
 * above. Elements marked translate="no" are left as they are, with what is in them.
 */
export function translatePage(root: Element = document.body): void {
  if (current === 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node instanceof Element && (node.getAttribute('translate') === 'no' || node.localName === 'script' || node.localName === 'style')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node: Node | null = root; node; node = walker.nextNode()) {
    if (node instanceof Element) {
      for (const name of TEXT_ATTRIBUTES) {
        const value = node.getAttribute(name);
        const key = value && normalize(value);
        if (key && key in messages) node.setAttribute(name, messages[key]!);
      }
    } else if (node instanceof Text) {
      const key = normalize(node.data);
      if (!key || !(key in messages)) continue;
      const [, before = '', after = ''] = /^(\s*)[\s\S]*?(\s*)$/.exec(node.data) ?? [];
      node.data = `${before}${messages[key]}${after}`;
    }
  }
}
