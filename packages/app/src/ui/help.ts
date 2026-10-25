// The Help dialog: tabs for keys, effects, formats and workflows, a search
// across all of them, and a jump to the effect under the pattern cursor.

import { HELP_SECTIONS, entryMatches, findEntry, sectionOf, type HelpEntry, type HelpGroup, type HelpTarget } from './help-content.ts';

export interface Help {
  open(target?: HelpTarget | null): void;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

function entryHtml(entry: HelpEntry): string {
  const name = entry.name ? `<b>${escape(entry.name)}</b> ` : '';
  const id = entry.id ? ` data-id="${entry.id}"` : '';
  return `<div class="help-entry"${id}><span class="help-code">${escape(entry.code)}</span><span>${name}${escape(entry.text)}</span></div>`;
}

function groupHtml(group: HelpGroup): string {
  const title = group.title ? `<h3 class="ptitle">${escape(group.title)}</h3>` : '';
  const intro = group.intro ? `<p class="help-intro">${escape(group.intro)}</p>` : '';
  const list = group.entries.length ? `<div class="help-list">${group.entries.map(entryHtml).join('')}</div>` : '';
  return `<div class="help-group">${title}${intro}${list}</div>`;
}

export function mountHelp(dialog: HTMLDialogElement): Help {
  const tabs = dialog.querySelector<HTMLElement>('.help-tabs')!;
  const body = dialog.querySelector<HTMLElement>('.help-body')!;
  const search = dialog.querySelector<HTMLInputElement>('.help-search')!;
  const context = dialog.querySelector<HTMLElement>('.help-context')!;
  const empty = dialog.querySelector<HTMLElement>('.help-empty')!;
  const manual = dialog.querySelector<HTMLAnchorElement>('.help-manual');

  tabs.innerHTML = HELP_SECTIONS.map(
    (s) => `<button type="button" class="btn sm" role="tab" data-section="${s.id}">${escape(s.title)}</button>`,
  ).join('');
  body.insertAdjacentHTML(
    'afterbegin',
    HELP_SECTIONS.map((s) => `<section class="help-section" data-section="${s.id}">${s.groups.map(groupHtml).join('')}</section>`).join(''),
  );
  const sectionEls = [...body.querySelectorAll<HTMLElement>('.help-section')];
  const tabEls = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  let active = HELP_SECTIONS[0]!.id;

  // Entries and group intros by element, to filter without looking the text up again.
  const entryOf = new Map<HTMLElement, HelpEntry>();
  const groupOf = new Map<HTMLElement, HelpGroup>();
  sectionEls.forEach((el, i) => {
    const groups = HELP_SECTIONS[i]!.groups;
    el.querySelectorAll<HTMLElement>('.help-group').forEach((g, j) => {
      const group = groups[j]!;
      groupOf.set(g, group);
      g.querySelectorAll<HTMLElement>('.help-entry').forEach((e, k) => entryOf.set(e, group.entries[k]!));
    });
  });

  function render(): void {
    const query = search.value.trim();
    let matches = 0;
    for (const el of sectionEls) {
      el.hidden = !query && el.dataset.section !== active;
      if (el.hidden) continue;
      let sectionMatches = 0;
      for (const [g, group] of groupOf) {
        if (!el.contains(g)) continue;
        let groupMatches = 0;
        for (const e of g.querySelectorAll<HTMLElement>('.help-entry')) {
          const hit = !query || entryMatches(entryOf.get(e)!, query);
          e.hidden = !hit;
          if (hit) groupMatches++;
        }
        const introHit = !query || entryMatches({ code: group.title ?? '', text: group.intro ?? '' }, query);
        g.hidden = groupMatches === 0 && !introHit;
        if (!g.hidden) sectionMatches++;
      }
      el.hidden = sectionMatches === 0;
      matches += sectionMatches;
    }
    for (const tab of tabEls) tab.setAttribute('aria-selected', String(!query && tab.dataset.section === active));
    // The manual opens at the topic shown here; Workflow is covered by its chapters.
    manual?.setAttribute('href', `./manual.html#${active === 'workflow' ? 'start' : `ref-${active}`}`);
    empty.hidden = matches > 0;
  }

  function show(section: string): void {
    active = section;
    search.value = '';
    render();
    body.scrollTop = 0;
  }

  for (const tab of tabEls) tab.addEventListener('click', () => show(tab.dataset.section!));
  search.addEventListener('input', () => {
    render();
    body.scrollTop = 0;
  });

  return {
    open(target) {
      for (const el of body.querySelectorAll('.help-entry.hit')) el.classList.remove('hit');
      const entry = target ? findEntry(target.id) : null;
      context.hidden = !entry;
      if (target && entry) {
        context.textContent = `Under the cursor: ${target.shown} – ${entry.name ?? entry.code}`;
        show(sectionOf(target.id)!.id);
      } else {
        render();
      }
      if (!dialog.open) dialog.showModal();
      const el = target && body.querySelector<HTMLElement>(`[data-id="${target.id}"]`);
      if (el) {
        manual?.setAttribute('href', `./manual.html#${target!.id}`);
        el.classList.add('hit');
        // The entry itself has no box on wide screens (display: contents), its code does.
        el.firstElementChild!.scrollIntoView({ block: 'center' });
      } else if (!matchMedia('(pointer: coarse)').matches) {
        // Typing searches at once on a keyboard; on phones that would pop up the on-screen one.
        search.focus();
      }
    },
  };
}
