// S-SS-4 — conditional writes and the atomic commit (§5.5.3; R-STORE-4).
import { expect, it } from 'vitest';
import { COMMIT_BOUND, FRAME, MAX_FILE_SIZE } from '../../src/core/protocol';
import { api, hello, newSpace } from '../lib/harness';
import { withCore } from '#host';

const logRows = (spaceId: string) => withCore(spaceId, (core) => core.store.exec<{ n: number }>('SELECT COUNT(*) AS n FROM changes').one().n);

it('S-SS-4: a stale basedOn is a conflict, on put and on delete', async () => {
  const { spaceId, owner } = await newSpace();
  expect((await api(spaceId, owner, 'put', { path: '/a', data: 'v1', basedOn: 0 })).body).toEqual({ seq: 1, rev: 1 });
  // basedOn 0 means "no file here".
  expect((await api(spaceId, owner, 'put', { path: '/a', data: 'again', basedOn: 0 })).body).toEqual({ error: 'conflict', paths: ['/a'] });
  expect((await api(spaceId, owner, 'put', { path: '/a', data: 'v2', basedOn: 1 })).body).toEqual({ seq: 2, rev: 2 });
  const stale = await api(spaceId, owner, 'put', { path: '/a', data: 'lost', basedOn: 1 });
  expect(stale.status).toBe(409);
  expect((await api(spaceId, owner, 'delete', { path: '/a', basedOn: 1 })).status).toBe(409);
  expect((await api(spaceId, owner, 'read', { path: '/a' })).body).toEqual({ data: 'v2', rev: 2 });
  // Without basedOn the last writer wins.
  expect((await api(spaceId, owner, 'put', { path: '/a', data: 'v3' })).body).toEqual({ seq: 3, rev: 3 });
  expect((await api(spaceId, owner, 'delete', { path: '/a', basedOn: 3 })).body).toEqual({ seq: 4 });
  expect((await api(spaceId, owner, 'read', { path: '/a' })).status).toBe(404);
  // A rev is never reused on a path: the file's next life starts above its last.
  expect((await api(spaceId, owner, 'put', { path: '/a', data: 'reborn', basedOn: 0 })).body).toEqual({ seq: 5, rev: 5 });
});

it('S-SS-4: a commit with one stale entry applies nothing and logs nothing', async () => {
  const { spaceId, owner } = await newSpace();
  await api(spaceId, owner, 'put', { path: '/a', data: 1 });
  await api(spaceId, owner, 'put', { path: '/a', data: 2 });
  const feed = await hello(spaceId, owner);
  await feed.settle();
  const before = await logRows(spaceId);

  const res = await api(spaceId, owner, 'commit', {
    changes: [
      { op: 'put', path: '/b', data: 'new' },
      { op: 'put', path: '/a', data: 'stale', basedOn: 1 },
      { op: 'delete', path: '/c' },
    ],
  });
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ error: 'conflict', paths: ['/a'] });
  expect((await api(spaceId, owner, 'read', { path: '/b' })).status).toBe(404);
  expect((await api(spaceId, owner, 'read', { path: '/a' })).body).toEqual({ data: 2, rev: 2 });
  expect(await logRows(spaceId)).toBe(before);
  expect(await feed.settle()).toEqual([]);
  // The seq was not consumed either: the next commit is gap-free.
  expect((await api(spaceId, owner, 'put', { path: '/b', data: 'new' })).body).toEqual({ seq: 3, rev: 3 });
});

it('S-SS-4: a commit over the bound is boundExceeded; one at the bound is a single delta', async () => {
  const { spaceId, owner } = await newSpace();
  const feed = await hello(spaceId, owner);
  await feed.settle();
  const changes = (n: number) => Array.from({ length: n }, (_, i) => ({ op: 'put', path: `/n/${String(i).padStart(4, '0')}`, data: i }));

  const over = await api(spaceId, owner, 'commit', { changes: changes(COMMIT_BOUND + 1) });
  expect(over.status).toBe(413);
  expect(over.body).toEqual({ error: 'boundExceeded' });
  expect(await logRows(spaceId)).toBe(0);
  expect(await feed.settle()).toEqual([]);

  expect((await api(spaceId, owner, 'commit', { changes: changes(COMMIT_BOUND) })).body).toEqual({ seq: 1 });
  const frames = await feed.settle();
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ type: FRAME.delta, seq: 1 });
  expect((frames[0] as { changes: unknown[] }).changes).toHaveLength(COMMIT_BOUND);
});

it('S-SS-4: malformed writes are refused whole, and a reader never learns which', async () => {
  const { spaceId, owner, r } = await newSpace('r');
  await api(spaceId, owner, 'setRole', { uid: 'user:r', role: 'reader' });
  const bad = [
    ['put', { path: '', data: 1 }],
    ['put', { path: '/a' }],
    ['put', { path: '/a', data: 1, basedOn: -1 }],
    ['put', { path: '/a', data: 'x'.repeat(MAX_FILE_SIZE) }],
    ['commit', { changes: [] }],
    ['commit', { changes: [{ op: 'put', path: '/a', data: 1 }, { op: 'delete', path: '/a' }] }],
    ['commit', { changes: [{ op: 'move', path: '/a' }] }],
  ] as const;
  for (const [verb, body] of bad) {
    expect((await api(spaceId, owner, verb, body)).body, JSON.stringify(body).slice(0, 80)).toEqual({ error: 'invalid' });
    // Authority is decided first: for a reader every write is forbidden, malformed or not.
    expect((await api(spaceId, r, verb, body)).status).toBe(403);
  }
  expect(await logRows(spaceId)).toBe(0);
  // The largest record that fits is accepted.
  const largest = 'x'.repeat(MAX_FILE_SIZE - 2);
  expect((await api(spaceId, owner, 'put', { path: '/big', data: largest })).status).toBe(200);
  expect((await api(spaceId, owner, 'read', { path: '/big' })).body.data).toHaveLength(MAX_FILE_SIZE - 2);
});
