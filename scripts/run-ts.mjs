// run-ts.mjs — run one of the repository's TypeScript entry points on Node:
//
//   node scripts/run-ts.mjs <entry.ts> [args…]
//
// It bundles the entry with esbuild into dist/ (dependencies stay external; `.sql` files load as
// text, as wrangler's Text rule bundles them for the Worker) and runs the result with the
// remaining arguments. `npm start` and `npm run drill` are this.
import { build } from 'esbuild';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node scripts/run-ts.mjs <entry.ts> [args…]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const outfile = resolve(root, 'dist', `${basename(entry).replace(/\.ts$/, '')}.mjs`);
await build({
  entryPoints: [resolve(root, entry)],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  loader: { '.sql': 'text' },
  logLevel: 'warning',
});
process.argv = [process.argv[0], outfile, ...args];
await import(pathToFileURL(outfile).href);
