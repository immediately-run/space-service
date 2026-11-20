// S-SS-3 — the tombstone (§5.5.4 Revocation): a soft delete revokes every socket in its own
// turn, and from then on the space answers like one that never existed.
import { expect, it } from 'vitest';
import { CLOSE, FRAME } from '../../src/core/protocol';
import { api, connect, hello, mint, newSpace, newSpaceId } from '../lib/harness';

it('S-SS-3: softDelete sends revoked to every socket, and a new hello is forbidden', async () => {
  const { spaceId, owner, b, c } = await newSpace('b', 'c');
  await api(spaceId, owner, 'setRole', { uid: 'user:b', role: 'writer' });
  await api(spaceId, owner, 'setRole', { uid: 'user:c', role: 'reader' });
  await api(spaceId, owner, 'put', { path: '/kept', data: 'x' });
  const feeds = [await hello(spaceId, owner), await hello(spaceId, b), await hello(spaceId, c), await hello(spaceId, c)];
  for (const f of feeds) await f.settle();
  const silent = await connect(spaceId);

  expect((await api(spaceId, owner, 'softDelete')).body).toEqual({ seq: 1 });
  for (const f of feeds) {
    expect(await f.next()).toEqual({ type: FRAME.revoked });
    expect(await f.closed).toMatchObject({ code: CLOSE.revoked.code });
  }
  // A socket that had not yet said hello is closed too, and told nothing.
  expect(await silent.closed).toMatchObject({ code: CLOSE.forbidden.code });
  expect(silent.raw).toEqual([]);

  // Forbidden for everyone, the owner included, exactly as an id that names no space.
  const nowhere = newSpaceId();
  for (const token of [owner, b, c]) {
    const after = await hello(spaceId, token);
    const never = await hello(nowhere, token);
    expect(await after.next()).toEqual({ type: FRAME.forbidden });
    expect(await never.next()).toEqual({ type: FRAME.forbidden });
    expect((await after.closed).code).toBe((await never.closed).code);
    for (const verb of ['read', 'put', 'members', 'setRole', 'softDelete', 'create'] as const) {
      const res = await api(spaceId, token, verb, { path: '/kept', data: 1, uid: 'user:z', role: 'reader' });
      expect(res.status, verb).toBe(403);
      if (verb !== 'create') expect(res.text).toBe((await api(nowhere, token, verb, { path: '/kept', data: 1, uid: 'user:z', role: 'reader' })).text);
    }
  }
  // The id is not reusable by anyone.
  expect((await api(spaceId, await mint('user:someone-else'), 'create')).status).toBe(403);
});
