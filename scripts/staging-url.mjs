// staging-url.mjs — where the staging Worker is, read from wrangler.toml, its one home:
//
//   node scripts/staging-url.mjs          → the staging URL, from [env.staging] routes
//   node scripts/staging-url.mjs --name       → the staging Worker's name
//   node scripts/staging-url.mjs --audience   → the audience its tokens must carry
//
// The TOML is parsed by a TOML parser and exactly these keys are read.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

function staging(tomlText) {
  const env = parse(tomlText).env?.staging;
  if (!env) throw new Error('wrangler.toml has no [env.staging]');
  return env;
}

/** `https://<host>` of the first route of `[env.staging]`. */
export function stagingUrl(tomlText) {
  const pattern = staging(tomlText).routes?.[0]?.pattern;
  if (typeof pattern !== 'string' || !pattern) throw new Error('wrangler.toml [env.staging] has no route pattern');
  const slash = pattern.indexOf('/');
  return `https://${slash < 0 ? pattern : pattern.slice(0, slash)}`;
}

/** The staging Worker's script name. */
export function stagingName(tomlText) {
  const { name } = staging(tomlText);
  if (typeof name !== 'string' || !name) throw new Error('wrangler.toml [env.staging] has no name');
  return name;
}

/** The `aud` the staging Worker requires. */
export function stagingAudience(tomlText) {
  const audience = staging(tomlText).vars?.TOKEN_AUDIENCE;
  if (typeof audience !== 'string' || !audience) throw new Error('wrangler.toml [env.staging.vars] has no TOKEN_AUDIENCE');
  return audience;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const toml = readFileSync(resolve(import.meta.dirname, '..', 'wrangler.toml'), 'utf8');
  console.log(process.argv.includes('--name') ? stagingName(toml) : process.argv.includes('--audience') ? stagingAudience(toml) : stagingUrl(toml));
}
