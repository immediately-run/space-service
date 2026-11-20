// S-SS-2 — a role change reaches a live socket in the turn that commits it (§5.5.4 Revocation;
// §9: "A membership transition, its latch set and its revocation push are one object turn").
import { expect, it } from 'vitest';
import { CLOSE, FRAME } from '../../src/core/protocol';
import { api, hello, newSpace } from '../lib/harness';

it('S-SS-2: a downgraded writer gets access with the committed seq, is closed, and gets no later delta', async () => {
  const { spaceId, owner, b } = await newSpace('b');
  expect((await api(spaceId, owner, 'setRole', { uid: 'user:b', role: 'writer' })).status).toBe(200);

  const writer = await hello(spaceId, b);
  const watcher = await hello(spaceId, owner);
  expect(await writer.settle()).toEqual([
    { type: FRAME.access, role: 'writer', seq: 0 },
    { type: FRAME.snapshot, seq: 0, docs: [] },
  ]);
  await watcher.settle();

  expect((await api(spaceId, b, 'put', { path: '/one', data: 1 })).body).toEqual({ seq: 1, rev: 1 });
  expect(await writer.next()).toMatchObject({ type: FRAME.delta, seq: 1 });

  expect((await api(spaceId, owner, 'setRole', { uid: 'user:b', role: 'reader' })).body).toEqual({ seq: 1 });
  expect(await writer.next()).toEqual({ type: FRAME.access, role: 'reader', seq: 1 });
  expect(await writer.closed).toMatchObject({ code: CLOSE.access.code });

  // A later commit reaches the owner's socket and not the closed one.
  expect((await api(spaceId, owner, 'put', { path: '/two', data: 2 })).body).toEqual({ seq: 2, rev: 2 });
  expect(await watcher.settle()).toEqual([
    { type: FRAME.delta, seq: 1, changes: [{ path: '/one', op: 'put', rev: 1 }] },
    { type: FRAME.delta, seq: 2, changes: [{ path: '/two', op: 'put', rev: 2 }] },
  ]);
  expect(writer.drain()).toEqual([]);

  // Reconnected, it resumes as a reader: it reads, and may no longer write.
  const reader = await hello(spaceId, b, 1);
  expect(await reader.settle()).toEqual([
    { type: FRAME.access, role: 'reader', seq: 2 },
    { type: FRAME.delta, seq: 2, changes: [{ path: '/two', op: 'put', rev: 2 }] },
  ]);
  expect((await api(spaceId, b, 'read', { path: '/two' })).body).toEqual({ data: 2, rev: 2 });
  expect((await api(spaceId, b, 'put', { path: '/three', data: 3 })).status).toBe(403);
});

it('S-SS-2: an unshared member gets revoked, is closed, and is forbidden from then on', async () => {
  const { spaceId, owner, b, c } = await newSpace('b', 'c');
  await api(spaceId, owner, 'setRole', { uid: 'user:b', role: 'reader' });
  await api(spaceId, owner, 'setRole', { uid: 'user:c', role: 'reader' });
  const gone = await hello(spaceId, b);
  const stays = await hello(spaceId, c);
  await gone.settle();
  await stays.settle();

  expect((await api(spaceId, owner, 'unshare', { uid: 'user:b' })).status).toBe(200);
  expect(await gone.next()).toEqual({ type: FRAME.revoked });
  expect(await gone.closed).toMatchObject({ code: CLOSE.revoked.code });
  // Only that uid's sockets: the other reader is undisturbed.
  await api(spaceId, owner, 'put', { path: '/x', data: 1 });
  expect(await stays.settle()).toMatchObject([{ type: FRAME.delta, seq: 1 }]);

  const again = await hello(spaceId, b);
  expect(await again.next()).toEqual({ type: FRAME.forbidden });
  expect((await api(spaceId, b, 'read', { path: '/x' })).status).toBe(403);
});

it('S-SS-2: only an owner changes membership, and never the anchor owner', async () => {
  const { spaceId, owner, b } = await newSpace('b');
  await api(spaceId, owner, 'setRole', { uid: 'user:b', role: 'writer' });
  expect((await api(spaceId, b, 'setRole', { uid: 'user:c', role: 'reader' })).status).toBe(403);
  expect((await api(spaceId, b, 'unshare', { uid: 'user:owner' })).status).toBe(403);
  expect((await api(spaceId, b, 'softDelete')).status).toBe(403);
  expect((await api(spaceId, owner, 'setRole', { uid: 'user:owner', role: 'reader' })).status).toBe(400);
  expect((await api(spaceId, owner, 'unshare', { uid: 'user:owner' })).status).toBe(400);
  expect((await api(spaceId, owner, 'members')).body.members).toEqual([
    { uid: 'user:b', role: 'writer' },
    { uid: 'user:owner', role: 'owner' },
  ]);
});
