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

// Relative asset paths: the same build works at the domain root, in a
// subfolder and from a local preview.
export default defineConfig({
  base: './',
  plugins: [licenses()],
  // ES module workers can split off chunks, so the MP3 encoder loads only when needed.
  worker: { format: 'es' },
  build: {
    rolldownOptions: {
      input: { main: 'index.html', manual: 'manual.html' },
    },
  },
});
