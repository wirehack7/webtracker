import { afterEach, describe, expect, it } from 'vitest';
import { useMessages } from '../i18n/i18n.ts';
import { HELP_SECTIONS, cellHelpTarget, localizeHelp, effectHelpId, entryMatches, findEntry, sectionOf, volumeHelpId } from './help-content.ts';

describe('help content', () => {
  it('has unique entry ids', () => {
    const ids = HELP_SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.entries.flatMap((e) => (e.id ? [e.id] : []))));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('explains every effect the editor can enter', () => {
    for (const e of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'F', 'G', 'H', 'K', 'L', 'M', 'N', 'P', 'R', 'T', 'X']) {
      expect(findEntry(`fx-${e}`), e).not.toBeNull();
    }
    for (let x = 0; x < 16; x++) {
      if (x !== 0xd) expect(effectHelpId(0x0e, x << 4), `E${x}`).toMatch(/^fx-E/);
    }
    expect(findEntry('fx-ED')).not.toBeNull();
  });

  it('maps cells to entries', () => {
    expect(effectHelpId(0, 0)).toBeNull();
    expect(effectHelpId(0, 0x37)).toBe('fx-0');
    expect(effectHelpId(0x0a, 0x0f)).toBe('fx-A');
    expect(effectHelpId(0x0e, 0xc3)).toBe('fx-EC');
    expect(effectHelpId(0x21, 0x12)).toBe('fx-X');
    expect(effectHelpId(0x13, 0)).toBeNull(); // J has no meaning in XM
    expect(volumeHelpId(0)).toBeNull();
    expect(volumeHelpId(0x50)).toBe('vol-set');
    expect(volumeHelpId(0x63)).toBe('vol--');
    expect(volumeHelpId(0xf4)).toBe('vol-M');
    expect(cellHelpTarget('effect', { volume: 0, effect: 0x0c, param: 0x20 })).toEqual({ id: 'fx-C', shown: 'C20' });
    expect(cellHelpTarget('volume', { volume: 0xc8, effect: 0, param: 0 })).toEqual({ id: 'vol-P', shown: 'P8' });
    expect(sectionOf('vol-P')?.id).toBe('effects');
  });

  it('searches code, name and text by all words', () => {
    const entry = findEntry('fx-E9')!;
    expect(entryMatches(entry, 'retrigger')).toBe(true);
    expect(entryMatches(entry, 'E9x drum')).toBe(true);
    expect(entryMatches(entry, 'retrigger vibrato')).toBe(false);
  });
});

describe('localizeHelp', () => {
  afterEach(() => useMessages('en', {}));

  it('translates the help once and keeps the English text searchable', () => {
    const entry = findEntry('fx-E9')!;
    const english = `${entry.code} ${entry.name ?? ''} ${entry.text}`;
    useMessages('de', { [entry.text]: 'Neu anschlagen', [HELP_SECTIONS[0]!.title]: 'Erster Teil' });
    localizeHelp();
    expect(entry.text).toBe('Neu anschlagen');
    expect(entry.source).toBe(english);
    expect(HELP_SECTIONS[0]!.title).toBe('Erster Teil');
    // Searching in English still finds it, and a second call changes nothing.
    expect(entryMatches(entry, 'E9x')).toBe(true);
    useMessages('de', { 'Neu anschlagen': 'twice' });
    localizeHelp();
    expect(entry.text).toBe('Neu anschlagen');
  });

  it('has no entry for an empty cell', () => {
    expect(cellHelpTarget('effect', { volume: 0, effect: 0, param: 0 })).toBeNull();
  });
});
