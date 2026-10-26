// The What's new dialog: opens once after an update for people who used the
// tracker before, and from Help any time. First visits only note the latest
// release, so a new visitor is not greeted by a list of changes.

import { language, t } from '../i18n/i18n.ts';
import { CHANGELOG, type Release } from './changelog-content.ts';

/** The id of the newest release this browser has shown or skipped. */
export const SEEN_KEY = 'webtracker.whatsNew';

export const latestRelease = (): string => CHANGELOG[0]!.id;

/** Whether a release is new to someone who last saw `seen`; without one, only the latest is. */
export const isNew = (release: Release, seen: string | null): boolean => (seen === null ? release.id === latestRelease() : release.id > seen);

/** Whether to open on start: only for returning visitors who have not seen the latest release. */
export const shouldShow = (seen: string | null, returning: boolean): boolean => returning && (seen === null || seen < latestRelease());

/** Whether this browser has used the tracker before: it has kept something of it. */
export function hasVisitedBefore(storage: Storage): boolean {
  for (let i = 0; i < storage.length; i++) {
    if (storage.key(i)?.startsWith('webtracker.')) return true;
  }
  return false;
}

export function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, latestRelease());
  } catch {
    // Private mode without storage: the dialog may come once more.
  }
}

function formatDate(id: string): string {
  const [year, month, day] = id.slice(0, 10).split('-').map(Number);
  const date = new Date(year!, month! - 1, day!);
  return Number.isNaN(date.getTime()) ? id : date.toLocaleDateString(language(), { year: 'numeric', month: 'long', day: 'numeric' });
}

export interface WhatsNew {
  open(): void;
}

export function mountWhatsNew(dialog: HTMLDialogElement): WhatsNew {
  const body = dialog.querySelector<HTMLElement>('.whats-new-body')!;
  dialog.addEventListener('close', markSeen);
  return {
    open() {
      const seen = readSeen();
      body.replaceChildren(
        ...CHANGELOG.flatMap((release) => {
          const head = document.createElement('h3');
          head.className = 'ptitle';
          head.textContent = formatDate(release.id);
          if (isNew(release, seen)) {
            const badge = document.createElement('span');
            badge.className = 'whats-new-badge';
            badge.textContent = t('New');
            head.append(' ', badge);
          }
          const list = document.createElement('ul');
          list.className = 'whats-new-list';
          list.append(...release.items.map((item) => Object.assign(document.createElement('li'), { textContent: t(item) })));
          return [head, list];
        }),
      );
      if (!dialog.open) dialog.showModal();
      body.scrollTop = 0;
      dialog.scrollTop = 0;
    },
  };
}
