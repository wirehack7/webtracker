// Installing chiptrackr as an app and keeping it up to date. The service worker
// (scripts/service-worker.mjs) caches the whole site; a new version waits until
// the page asks it to take over, so a running tracker never mixes two versions.

/** What Setup offers for installing: already installed, the browser's own prompt, the iOS share sheet, or nothing. */
export type InstallState = 'installed' | 'prompt' | 'ios' | 'none';

export function installState(standalone: boolean, canPrompt: boolean, appleTouch: boolean): InstallState {
  if (standalone) return 'installed';
  if (canPrompt) return 'prompt';
  return appleTouch ? 'ios' : 'none';
}

/** True when the page runs in its own app window rather than in a browser tab. */
export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** Chromium's install prompt, held until the player asks for it. */
export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface UpdateHooks {
  /** The site was cached for the first time and now works offline. */
  offlineReady(): void;
  /** A new version is installed and waits for a reload. */
  updateReady(): void;
  /** Another tab switched to a new version under this one. */
  updatedElsewhere(): void;
}

/** Checking for a new version on every return to the tab would be too often. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

let registration: ServiceWorkerRegistration | null = null;
let switching = false;

/** Registers the service worker and reports when it caches the site or finds a new version. */
export async function registerServiceWorker(url: string, hooks: UpdateHooks): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  registration = await sw.register(url);
  sw.addEventListener('controllerchange', () => {
    if (switching) location.reload();
    else if (hadController) hooks.updatedElsewhere();
  });
  const watch = (worker: ServiceWorker | null) => {
    worker?.addEventListener('statechange', () => {
      if (worker.state !== 'installed') return;
      if (sw.controller) hooks.updateReady();
      else hooks.offlineReady();
    });
  };
  if (registration.waiting && sw.controller) hooks.updateReady();
  watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration?.installing ?? null));
  let checked = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - checked < CHECK_EVERY_MS) return;
    checked = Date.now();
    void registration?.update().catch(() => {});
  });
}

/** Lets the waiting version take over; the page reloads once it has. */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) {
    location.reload();
    return;
  }
  switching = true;
  waiting.postMessage('skip-waiting');
}

interface LaunchParams {
  files: FileSystemFileHandle[];
}

/** Files opened with the installed app (file_handlers in the manifest) are handed to `open`. */
export function onLaunchFiles(open: (file: File) => Promise<void>): void {
  const queue = (window as { launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void } }).launchQueue;
  queue?.setConsumer((params) => {
    void (async () => {
      for (const handle of params.files) await open(await handle.getFile());
    })();
  });
}
