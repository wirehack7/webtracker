/**
 * Prints coverage/coverage-summary.json (from `pnpm test:coverage`) as a
 * Markdown table per package, for the CI job summary.
 */
import { readFileSync } from 'node:fs';

const summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
const keys = ['lines', 'statements', 'branches', 'functions'];
const packages = new Map();
for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  const name = file.match(/packages\/([^/]+)\//)?.[1] ?? 'other';
  const sums = packages.get(name) ?? Object.fromEntries(keys.map((k) => [k, { covered: 0, total: 0 }]));
  for (const k of keys) {
    sums[k].covered += data[k].covered;
    sums[k].total += data[k].total;
  }
  packages.set(name, sums);
}
packages.set('**all**', summary.total);

const pct = ({ covered, total }) => (total ? ((100 * covered) / total).toFixed(1) : '100.0') + ' %';
console.log(`| Package | ${keys.map((k) => k[0].toUpperCase() + k.slice(1)).join(' | ')} |`);
console.log(`| --- | ${keys.map(() => '---:').join(' | ')} |`);
for (const [name, sums] of packages) console.log(`| ${name} | ${keys.map((k) => pct(sums[k])).join(' | ')} |`);
