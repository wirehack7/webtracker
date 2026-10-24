import { defineConfig, type Plugin } from 'vite';

/**
 * Writes sw.js next to the build with the list of every emitted file, so the
 * service worker can cache the whole app on first visit and run it offline.
 */
function serviceWorker(): Plugin {
  return {
    name: 'webtracker-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = ['./', ...Object.keys(bundle).map((f) => `./${f}`), './manifest.webmanifest', './icon.svg'];
      const version = Object.keys(bundle).sort().join('|');
      let hash = 0;
      for (let i = 0; i < version.length; i++) hash = (Math.imul(hash, 31) + version.charCodeAt(i)) | 0;
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: SW_SOURCE.replace('__CACHE__', `webtracker-${(hash >>> 0).toString(36)}`).replace(
          '__FILES__',
          JSON.stringify(files),
        ),
      });
    },
  };
}

const SW_SOURCE = `// Generated at build time. Cache first for the app's own files, network for the rest.
const CACHE = '__CACHE__';
const FILES = __FILES__;
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  // Pages try the network first so a new deploy shows up; offline they come from the cache.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./', { cacheName: CACHE, ignoreVary: true })));
    return;
  }
  event.respondWith(caches.match(request, { cacheName: CACHE, ignoreVary: true }).then((hit) => hit || fetch(request)));
});
`;

// Relative asset paths: the same build works under GitHub Pages' /webtracker/
// and from any other folder or local preview.
export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
});
