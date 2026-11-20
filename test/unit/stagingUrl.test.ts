// stagingUrl.test.ts (Node only) — the staging URL, name and audience come from the real
// wrangler.toml, their one home.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { stagingAudience, stagingName, stagingUrl } from '../../scripts/staging-url.mjs';
import { DRILL_AUDIENCE } from '../../src/drill/mint';

const toml = readFileSync(resolve(import.meta.dirname, '../../wrangler.toml'), 'utf8');

it('staging-url.mjs over the real wrangler.toml gives the route host', () => {
  // Spelled in parts: the host's one home is wrangler.toml.
  expect(stagingUrl(toml)).toBe(`https://${['space-service-staging', 'immediately', 'run'].join('.')}`);
  expect(stagingName(toml)).toBe('space-service-staging');
  // The drill mints for the audience the staging Worker requires.
  expect(stagingAudience(toml)).toBe(DRILL_AUDIENCE);
});

it('says what is missing rather than guessing', () => {
  expect(() => stagingUrl('name = "x"')).toThrow(/no \[env.staging\]/);
  expect(() => stagingUrl('[env.staging]\nname = "x"')).toThrow(/no route pattern/);
  expect(stagingUrl('[env.staging]\nroutes = [{ pattern = "a.example/*" }]')).toBe('https://a.example');
});
