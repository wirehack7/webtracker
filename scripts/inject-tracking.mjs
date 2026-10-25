// Replaces the <!-- tracking-code --> placeholder in every built HTML page
// with the TRACKING_CODE environment variable. Runs only in the deploy
// workflow, so the source tree carries no tracking code and forks that do
// not set the repository variable deploy without it.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PLACEHOLDER = '<!-- tracking-code -->';
const dir = process.argv[2] ?? 'packages/app/dist';
const code = process.env.TRACKING_CODE?.trim() ?? '';
if (!code) console.log('TRACKING_CODE not set, removing the placeholder only.');

const pages = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.html'));
for (const page of pages) {
  const path = join(dir, page);
  const html = await readFile(path, 'utf8');
  if (!html.includes(PLACEHOLDER)) continue;
  // A function replacement keeps "$" in the code from being read as a pattern.
  await writeFile(path, html.replaceAll(PLACEHOLDER, () => code));
  if (code) console.log(`Tracking code added to ${page}`);
}
