// S-SS-8 — the echo (§5.5.4): a delta carries its writer's opId, which is how a holder tells its
// own write from a remote one.
import { expect, it } from 'vitest';
import { FRAME } from '../../src/core/protocol';
import { api, hello, newSpace } from '../lib/harness';

it("S-SS-8: a delta carries its writer's opId", async () => {
  const { spaceId, owner, w } = await newSpace('w');
  await api(spaceId, owner, 'setRole', { uid: 'user:w', role: 'writer' });
  const mine = await hello(spaceId, owner);
  const theirs = await hello(spaceId, w);
  await mine.settle();
  await theirs.settle();

  await api(spaceId, owner, 'put', { path: '/a', data: 1, opId: 'owner-1' });
  await api(spaceId, w, 'put', { path: '/b', data: 2 });
  await api(spaceId, w, 'commit', { changes: [{ op: 'delete', path: '/a' }, { op: 'put', path: '/c', data: 3 }], opId: 'w-2' });
  await api(spaceId, owner, 'delete', { path: '/b', opId: 'owner-3' });

  const expected = [
    { type: FRAME.delta, seq: 1, opId: 'owner-1', changes: [{ path: '/a', op: 'put', rev: 1 }] },
    { type: FRAME.delta, seq: 2, changes: [{ path: '/b', op: 'put', rev: 2 }] },
    { type: FRAME.delta, seq: 3, opId: 'w-2', changes: [{ path: '/a', op: 'delete', rev: 3 }, { path: '/c', op: 'put', rev: 3 }] },
    { type: FRAME.delta, seq: 4, opId: 'owner-3', changes: [{ path: '/b', op: 'delete', rev: 4 }] },
  ];
  // Every member's socket gets the same deltas, opIds included, and a delta with no opId has no key.
  expect(await mine.settle()).toEqual(expected);
  expect(await theirs.settle()).toEqual(expected);
  // The opId survives in the log: a resumed feed replays it.
  const resumed = await hello(spaceId, w, 2);
  expect((await resumed.settle()).slice(1)).toEqual(expected.slice(2));
  // Deleting what is not there changes nothing, so there is nothing to echo.
  expect((await api(spaceId, owner, 'delete', { path: '/never', opId: 'owner-4' })).body).toEqual({ seq: 4 });
  expect(await mine.settle()).toEqual([]);
});
