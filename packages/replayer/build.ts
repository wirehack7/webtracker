/**
 * Builds the replayer as single, self-contained ES modules: the worklet is
 * built first and put into each bundle as text, so a page needs one file.
 * The result also goes into the app's build, to be served next to it.
 */
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { createDemoSong } from '@webtracker/engine';
import { saveXm } from '@webtracker/formats';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = `${root}dist`;
const appDist = `${root}../app/dist`;

function output(result: Awaited<ReturnType<typeof build>>): string {
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  const chunk = outputs[0]?.output.find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('Build produced no code');
  return chunk.code;
}

const worklet = output(
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: { write: false, minify: true, lib: { entry: 'src/worklet.ts', formats: ['es'] } },
  }),
);

const inlineWorklet: Plugin = {
  name: 'replayer-worklet',
  resolveId: (id) => (id === 'virtual:replayer-worklet' ? '\0replayer-worklet' : null),
  load: (id) => (id === '\0replayer-worklet' ? `export default ${JSON.stringify(worklet)};` : null),
};

await mkdir(dist, { recursive: true });
const sizes: string[] = [];
// The MIT License asks for the notice to stay with every copy.
const banner = '/*! chiptrackr replayer | (c) Markus Fritz | MIT License | github.com/wirehack7/webtracker */\n';
for (const [name, entry] of [
  ['webtracker-replayer', 'src/full.ts'],
  ['webtracker-replayer-lite', 'src/lite.ts'],
] as const) {
  const code = banner + output(
    await build({
      root,
      configFile: false,
      logLevel: 'warn',
      plugins: [inlineWorklet],
      build: { write: false, minify: true, lib: { entry, formats: ['es'] } },
    }),
  );
  await writeFile(`${dist}/${name}.js`, code);
  sizes.push(`${name}.js: ${(code.length / 1024).toFixed(1)} KB, ${(gzipSync(code).length / 1024).toFixed(1)} KB gzipped`);
}

await writeFile(`${dist}/demo.xm`, saveXm(createDemoSong()));
await writeFile(`${dist}/index.html`, await readFile(`${root}demo/index.html`));
console.log(sizes.join('\n'));

// The app build empties its folder, so it runs first and the replayer is added to it.
if (await stat(appDist).catch(() => null)) {
  await cp(dist, `${appDist}/replayer`, { recursive: true });
  console.log('Copied to app/dist/replayer');
}
