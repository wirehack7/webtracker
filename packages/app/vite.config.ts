import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * Publishes chiptrackr's license and the full license texts of the
 * third-party code and fonts the app ships, as their licenses ask.
 */
function licenses(): Plugin {
  // pnpm links each dependency into the app's node_modules.
  const text = (pkg: string) => readFileSync(new URL(`node_modules/${pkg}/LICENSE`, import.meta.url), 'utf8').trim();
  const repoText = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').trim();
  return {
    name: 'chiptrackr-licenses',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: `${repoText('LICENSE')}\n` });
      const parts = [
        ['Press Start 2P (@fontsource/press-start-2p), SIL Open Font License 1.1', text('@fontsource/press-start-2p')],
        ['lamejs (@breezystack/lamejs), GNU Lesser General Public License 3.0', text('@breezystack/lamejs')],
        ['GNU Lesser General Public License 3.0', repoText('licenses/LGPL-3.0.txt')],
        ['GNU General Public License 3.0 (which the LGPL 3.0 builds on)', repoText('licenses/GPL-3.0.txt')],
        ['Mediabunny (mediabunny), Mozilla Public License 2.0', text('mediabunny')],
      ];
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-licenses.txt',
        source:
          'Third-party components shipped with chiptrackr. See THIRD_PARTY_NOTICES.md in\n' +
          'https://github.com/wirehack7/webtracker for how each one is used.\n\n' +
          parts.map(([name, body]) => `==== ${name} ====\n\n${body}\n`).join('\n'),
      });
    },
  };
}

/**
 * Writes sw.js next to the build with the list of every emitted file, so the
 * service worker can cache the whole app on first visit and run it offline.
 */
function serviceWorker(): Plugin {
  return {
    name: 'chiptrackr-service-worker',
    apply: 'build',
    // After Vite has added the HTML pages to the bundle.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const files = ['./', ...Object.keys(bundle).map((f) => `./${f}`), './manifest.webmanifest', './icon.svg', './favicon.ico'];
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
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request, { cacheName: CACHE, ignoreVary: true, ignoreSearch: true })
          .then((hit) => hit || caches.match('./', { cacheName: CACHE, ignoreVary: true }))),
    );
    return;
  }
  event.respondWith(caches.match(request, { cacheName: CACHE, ignoreVary: true }).then((hit) => hit || fetch(request)));
});
`;

// Relative asset paths: the same build works at the domain root, in a
// subfolder and from a local preview.
export default defineConfig({
  base: './',
  plugins: [licenses(), serviceWorker()],
  // ES module workers can split off chunks, so the MP3 encoder loads only when needed.
  worker: { format: 'es' },
  build: {
    rolldownOptions: {
      input: { main: 'index.html', manual: 'manual.html' },
    },
  },
});
