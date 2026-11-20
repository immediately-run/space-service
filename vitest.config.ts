// vitest.config.ts — the space service under test on both hosts (STORE_PORTABILITY_SPEC §5.5.6,
// §9 must-establish): the `cloudflare` project runs the suite in the Workers runtime against the
// Worker and its Durable Objects; the `local` project runs every integration scenario again
// against the Node host, plus the tests only Node can run.
//
// The token signing key is made here, per run, and exists only in these bindings: wrangler.toml
// names no key, so no deployment ever trusts a test key.
import { defineConfig, type Plugin } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The tests only the local project runs, because they need Node (fake timers, the request
 * queue, the file system, a child process). Unit tests only: an integration scenario that runs
 * on one host is no conformance suite, and test/unit/hosts.test.ts fails the run if one is
 * ever listed here or excluded below.
 */
export const NODE_ONLY = [
  'test/unit/feedClient.test.ts',
  'test/unit/queue.test.ts',
  'test/unit/hosts.test.ts',
  'test/unit/localHost.test.ts',
  'test/unit/report.test.ts',
  'test/unit/mint.test.ts',
  'test/unit/stagingUrl.test.ts',
  'test/unit/costProbe.test.ts',
];
const INTEGRATION = 'test/integration/**/*.test.ts';
const UNIT = 'test/unit/**/*.test.ts';
/** What each project runs, exported for test/unit/hosts.test.ts. */
export const PROJECTS = {
  cloudflare: { include: [INTEGRATION, UNIT], exclude: [...NODE_ONLY] },
  local: { include: [INTEGRATION, UNIT], exclude: [] as string[] },
};

async function testKeys() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    TOKEN_PUBLIC_KEY_PEM: await exportSPKI(publicKey),
    TEST_SIGNING_JWK: JSON.stringify(await exportJWK(privateKey)),
    TEST_SIGNING_PEM: await exportPKCS8(privateKey),
  };
}

/** Schema migrations load as text, as wrangler's Text rule bundles them. */
const textModules: Plugin = {
  name: 'space-service-text-modules',
  enforce: 'pre',
  load(id) {
    const file = id.split('?')[0];
    return file.endsWith('.sql') ? `export default ${JSON.stringify(readFileSync(file, 'utf8'))};` : null;
  },
};

const host = (name: string) => ({ '#host': resolve(import.meta.dirname, `test/hosts/${name}.ts`) });

const keys = await testKeys();
const bindings = { TOKEN_AUDIENCE: 'space-service-test', TOKEN_PUBLIC_KEY_PEM: keys.TOKEN_PUBLIC_KEY_PEM, TEST_SIGNING_JWK: keys.TEST_SIGNING_JWK };

export default defineConfig({
  test: {
    testTimeout: 30_000,
    projects: [
      {
        plugins: [cloudflareTest(async () => ({ wrangler: { configPath: './wrangler.toml' }, miniflare: { bindings } }))],
        resolve: { alias: host('cloudflare') },
        test: {
          name: 'cloudflare',
          setupFiles: ['./test/setup.ts'],
          include: PROJECTS.cloudflare.include,
          exclude: PROJECTS.cloudflare.exclude,
        },
      },
      {
        plugins: [textModules],
        resolve: { alias: host('local') },
        test: {
          name: 'local',
          environment: 'node',
          setupFiles: ['./test/setup.ts'],
          include: PROJECTS.local.include,
          exclude: PROJECTS.local.exclude,
          provide: { localConfig: { ...bindings, TEST_SIGNING_PEM: keys.TEST_SIGNING_PEM } },
        },
      },
    ],
  },
});
