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
  // Version and source of each package, so the text says exactly what is shipped and where its source is.
  const about = (pkg: string, source: string) => `Version ${version(pkg)}. Source code: ${source}\n\n${text(pkg)}`;
  return {
    name: 'chiptrackr-licenses',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: `${repoText('LICENSE')}\n` });
      const parts = [
        [
          'Press Start 2P (@fontsource/press-start-2p), SIL Open Font License 1.1',
          about('@fontsource/press-start-2p', 'https://github.com/fontsource/font-files/tree/main/fonts/google/press-start-2p'),
        ],
        [
          'lamejs (@breezystack/lamejs), GNU Lesser General Public License 3.0',
          'lamejs is a JavaScript port of LAME (https://lame.sourceforge.io/) by Alex Zhukov,\n' +
            'copyright its authors and the LAME authors. It is used unmodified and built into its own\n' +
            'file, assets/lamejs-*.js, which can be replaced by any compatible build of lamejs.\n' +
            about('@breezystack/lamejs', 'https://github.com/shijinyu/lamejs and https://www.npmjs.com/package/@breezystack/lamejs'),
        ],
        ['GNU Lesser General Public License 3.0', repoText('licenses/LGPL-3.0.txt')],
        ['GNU General Public License 3.0 (which the LGPL 3.0 builds on)', repoText('licenses/GPL-3.0.txt')],
        [
          'Mediabunny (mediabunny), Mozilla Public License 2.0',
          'Copyright Vanilagy and contributors. Used unmodified, built into assets/video-worker-*.js.\n' +
            about('mediabunny', 'https://github.com/Vanilagy/mediabunny and https://www.npmjs.com/package/mediabunny'),
        ],
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

const version = (pkg: string): string =>
  JSON.parse(readFileSync(new URL(`node_modules/${pkg}/package.json`, import.meta.url), 'utf8')).version;

/**
 * Puts a license notice at the top of the lamejs chunk, so the file itself
 * says it is LGPL code and where its source and license are (LGPL 3.0, section 4).
 */
function lamejsNotice(): Plugin {
  const banner =
    `/*! lamejs ${version('@breezystack/lamejs')} (JavaScript port of LAME) | GNU LGPL 3.0 | ` +
    'source: https://github.com/shijinyu/lamejs | license texts: ../third-party-licenses.txt | ' +
    'replaceable by any compatible lamejs build */\n';
  return {
    name: 'chiptrackr-lamejs-notice',
    apply: 'build',
    renderChunk(code, chunk) {
      return chunk.moduleIds.some((id) => id.includes('/@breezystack/lamejs/')) ? banner + code : null;
    },
  };
}

// Relative asset paths: the same build works at the domain root, in a
// subfolder and from a local preview.
export default defineConfig({
  base: './',
  plugins: [licenses(), lamejsNotice()],
  // ES module workers can split off chunks, so the MP3 encoder loads only when needed.
  worker: { format: 'es', plugins: () => [lamejsNotice()] },
  build: {
    rolldownOptions: {
      input: { main: 'index.html', manual: 'manual.html' },
    },
  },
});
