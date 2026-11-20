// mint.test.ts (Node only) — the drill's tokens are ones the service's own verifier accepts,
// under the matching public key and no other.
import { exportSPKI, generateKeyPair } from 'jose';
import { expect, inject, it } from 'vitest';
import { SIGNING_PEM } from '#host';
import { verifyToken } from '../../src/core/auth';
import { DRILL_AUDIENCE, DRILL_TOKEN_TTL_SECONDS, minter } from '../../src/drill/mint';

const matching = inject('localConfig').TOKEN_PUBLIC_KEY_PEM;

it('a minted token verifies against the matching public key, and fails against another', async () => {
  const now = Date.now();
  const mint = await minter(SIGNING_PEM, { now: () => now });
  const token = await mint('drill:1');

  const claims = await verifyToken(token, { TOKEN_PUBLIC_KEY_PEM: matching, TOKEN_AUDIENCE: DRILL_AUDIENCE }, now);
  expect(claims).toEqual({ uid: 'drill:1', exp: (Math.floor(now / 1000) + DRILL_TOKEN_TTL_SECONDS) * 1000 });

  const other = await exportSPKI((await generateKeyPair('ES256')).publicKey);
  expect(await verifyToken(token, { TOKEN_PUBLIC_KEY_PEM: other, TOKEN_AUDIENCE: DRILL_AUDIENCE }, now)).toBeNull();
  // The audience binds it too, and so does its expiry.
  expect(await verifyToken(token, { TOKEN_PUBLIC_KEY_PEM: matching, TOKEN_AUDIENCE: 'space-service' }, now)).toBeNull();
  expect(await verifyToken(token, { TOKEN_PUBLIC_KEY_PEM: matching, TOKEN_AUDIENCE: DRILL_AUDIENCE }, now + DRILL_TOKEN_TTL_SECONDS * 1000 + 1000)).toBeNull();
});

it('a token is reused for half its life, then minted again', async () => {
  let now = Date.now();
  const mint = await minter(SIGNING_PEM, { now: () => now }, 'elsewhere');
  const first = await mint('drill:0');
  expect(await mint('drill:0')).toBe(first);
  expect(await mint('drill:1')).not.toBe(first);
  now += (DRILL_TOKEN_TTL_SECONDS * 1000) / 2 + 1000;
  const second = await mint('drill:0');
  expect(second).not.toBe(first);
  expect(await verifyToken(second, { TOKEN_PUBLIC_KEY_PEM: matching, TOKEN_AUDIENCE: 'elsewhere' }, now)).toMatchObject({ uid: 'drill:0' });
});
