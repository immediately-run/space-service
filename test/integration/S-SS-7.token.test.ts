// S-SS-7 — identity at the service (§5.5.5): one verifier, one refusal. Every token is signed by
// a real signer; the bad ones are bad in exactly one way each.
import { generateKeyPair } from 'jose';
import { expect, it } from 'vitest';
import { CLOSE, FORBIDDEN_FRAME, FRAME, HELLO_TIMEOUT_MS } from '../../src/core/protocol';
import { api, connect, hello, mint, newSpace, newSpaceId, setClock, tick } from '../lib/harness';

it('S-SS-7: an expired token, a wrong audience, a foreign key and a non-member all get the identical forbidden', async () => {
  const { spaceId, owner } = await newSpace();
  await api(spaceId, owner, 'put', { path: '/secret', data: 1 });
  const foreign = (await generateKeyPair('ES256')).privateKey;
  const refused: Record<string, string> = {
    expired: await mint('user:owner', { expiresIn: -5 }),
    'wrong audience': await mint('user:owner', { audience: 'some-other-service' }),
    'foreign key': await mint('user:owner', { key: foreign }),
    'no exp': await mint('user:owner', { noExp: true }),
    'non-member': await mint('user:stranger'),
    garbage: 'not.a.token',
  };

  const seen = new Set<string>();
  for (const [why, token] of Object.entries(refused)) {
    const feed = await hello(spaceId, token);
    const { code, reason } = await feed.closed;
    expect(feed.raw, why).toEqual([FORBIDDEN_FRAME]);
    seen.add(JSON.stringify([feed.raw, code, reason]));

    const res = await api(spaceId, token, 'read', { path: '/secret' });
    expect(res.status, why).toBe(403);
    seen.add(`http ${res.text}`);
  }
  // No token at all, and a space that does not exist, are the same answer again.
  seen.add(`http ${(await api(spaceId, null, 'read', { path: '/secret' })).text}`);
  seen.add(`http ${(await api(newSpaceId(), owner, 'read', { path: '/secret' })).text}`);
  // One distinct socket outcome and one distinct HTTP body, whatever the reason.
  expect([...seen]).toEqual([JSON.stringify([[FORBIDDEN_FRAME], CLOSE.forbidden.code, CLOSE.forbidden.reason]), 'http {"error":"forbidden"}']);
});

it('S-SS-7: a socket closes at its token exp, on the fake clock', async () => {
  const { spaceId } = await newSpace();
  const start = Date.now();
  const short = await mint('user:owner', { expiresIn: 120 });
  const long = await mint('user:owner', { expiresIn: 3600 });
  const expiring = await hello(spaceId, short);
  const staying = await hello(spaceId, long);
  await expiring.settle();
  await staying.settle();

  await setClock(spaceId, start + 110_000);
  await tick(spaceId);
  expect(await expiring.settle()).toEqual([]);

  await setClock(spaceId, start + 125_000);
  await tick(spaceId);
  expect(await expiring.closed).toMatchObject({ code: CLOSE.expired.code });
  expect(await staying.settle()).toEqual([]);

  // The core holds verbs to its own clock too: the short token is past its exp there.
  expect((await api(spaceId, short, 'put', { path: '/late', data: 1 })).status).toBe(403);
  expect((await api(spaceId, long, 'put', { path: '/on-time', data: 1 })).status).toBe(200);
  expect(await staying.next()).toMatchObject({ type: FRAME.delta, seq: 1 });
  // And a hello with it is refused like any other.
  const late = await hello(spaceId, short);
  expect(await late.next()).toEqual({ type: FRAME.forbidden });
});

it('S-SS-7: a socket that never says hello is closed at the deadline; a second hello is a protocol error', async () => {
  const { spaceId, owner } = await newSpace();
  const start = Date.now();
  const silent = await connect(spaceId);
  await setClock(spaceId, start + HELLO_TIMEOUT_MS + 2000);
  await tick(spaceId);
  expect(await silent.closed).toMatchObject({ code: CLOSE.forbidden.code });
  expect(silent.raw).toEqual([]);

  await setClock(spaceId, Date.now());
  const feed = await hello(spaceId, owner);
  await feed.settle();
  feed.send(JSON.stringify({ type: FRAME.hello, token: owner }));
  expect(await feed.closed).toMatchObject({ code: CLOSE.protocol.code });
});
