// S-SS-5 — a rename is one commit, so one delta (§5.5.3; §9: "A rename is atomic to every
// observer").
import { expect, it } from 'vitest';
import { FRAME, type ServerFrame } from '../../src/core/protocol';
import { api, hello, newSpace } from '../lib/harness';

it('S-SS-5: commit [delete old, put new] arrives as one delta; no observer sees both paths or neither', async () => {
  const { spaceId, owner, r } = await newSpace('r');
  await api(spaceId, owner, 'setRole', { uid: 'user:r', role: 'reader' });
  expect((await api(spaceId, owner, 'put', { path: '/old', data: 'content' })).body).toEqual({ seq: 1, rev: 1 });
  const feed = await hello(spaceId, r);
  await feed.settle();

  // Observers arriving while the rename commits: each is admitted wholly before it or wholly after.
  const rename = api(spaceId, owner, 'commit', { changes: [{ op: 'delete', path: '/old', basedOn: 1 }, { op: 'put', path: '/new', data: 'content', basedOn: 0 }], opId: 'rename-1' });
  const arriving = await Promise.all(Array.from({ length: 20 }, () => hello(spaceId, r)));
  expect((await rename).body).toEqual({ seq: 2 });

  expect(await feed.settle()).toEqual([
    {
      type: FRAME.delta,
      seq: 2,
      opId: 'rename-1',
      changes: [
        { path: '/new', op: 'put', rev: 2 },
        { path: '/old', op: 'delete', rev: 2 },
      ],
    },
  ]);

  for (const observer of arriving) {
    const frames = await observer.settle();
    const snapshot = frames.find((f): f is Extract<ServerFrame, { type: 'snapshot' }> => f.type === FRAME.snapshot)!;
    const paths = snapshot.docs.map((d) => d.path);
    // Before the rename: /old at seq 1, then the one delta. After: /new at seq 2, no delta.
    if (snapshot.seq === 1) {
      expect(paths).toEqual(['/old']);
      expect(frames.filter((f) => f.type === FRAME.delta)).toHaveLength(1);
    } else {
      expect(snapshot.seq).toBe(2);
      expect(paths).toEqual(['/new']);
      expect(frames.filter((f) => f.type === FRAME.delta)).toHaveLength(0);
    }
  }
  expect((await api(spaceId, r, 'read', { path: '/old' })).status).toBe(404);
  expect((await api(spaceId, r, 'read', { path: '/new' })).body).toEqual({ data: 'content', rev: 2 });
});
