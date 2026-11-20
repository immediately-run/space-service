// S-SS-1 — resume (§5.5.4; §9: "Resume delivers every delta once and in order, or a snapshot
// below the low-water mark"). The log is produced by real writes; the expected deltas are what
// a feed connected throughout actually received.
import { expect, it } from 'vitest';
import { FEED_RETENTION, FRAME, type ServerFrame } from '../../src/core/protocol';
import { api, hello, newSpace } from '../lib/harness';

const COMMITS = 300;

it('S-SS-1: every sinceSeq replays exactly the later deltas in order; below retention, a snapshot', async () => {
  const { spaceId, owner } = await newSpace();
  const live = await hello(spaceId, owner);
  expect(await live.settle()).toEqual([
    { type: FRAME.access, role: 'owner', seq: 0 },
    { type: FRAME.snapshot, seq: 0, docs: [] },
  ]);

  // 300 commits of every kind: puts, deletes of files that exist, and multi-file commits.
  const present = new Set<string>();
  for (let i = 1; i <= COMMITS; i++) {
    const path = `/f/${i % 20}`;
    let res;
    if (i % 7 === 6 && present.has(path)) {
      res = await api(spaceId, owner, 'delete', { path });
      present.delete(path);
    } else if (i % 5 === 4) {
      const other = `/g/${i % 3}`;
      res = await api(spaceId, owner, 'commit', { changes: [{ op: 'put', path, data: { i } }, { op: 'put', path: other, data: { i } }], opId: `op-${i}` });
      present.add(path).add(other);
    } else {
      res = await api(spaceId, owner, 'put', { path, data: { i } });
      present.add(path);
    }
    expect(res.body).toMatchObject({ seq: i });
  }
  const deltas = await live.settle();
  expect(deltas.map((d) => (d as { seq: number }).seq)).toEqual(Array.from({ length: COMMITS }, (_, i) => i + 1));
  expect(deltas.every((d) => d.type === FRAME.delta)).toBe(true);

  const fresh = await hello(spaceId, owner);
  const [, snapshot] = await fresh.settle();
  expect(snapshot).toMatchObject({ type: FRAME.snapshot, seq: COMMITS });
  expect((snapshot as Extract<ServerFrame, { type: 'snapshot' }>).docs.map((d) => d.path).sort()).toEqual([...present].sort());
  fresh.close();

  const lowWater = COMMITS - FEED_RETENTION;
  expect(lowWater).toBeGreaterThan(0);
  for (let since = 0; since <= COMMITS + 1; since++) {
    const feed = await hello(spaceId, owner, since);
    const [access, ...rest] = await feed.settle();
    expect(access).toEqual({ type: FRAME.access, role: 'owner', seq: COMMITS });
    if (since < lowWater || since > COMMITS) expect(rest, `sinceSeq ${since}`).toEqual([snapshot]);
    else expect(rest, `sinceSeq ${since}`).toEqual(deltas.slice(since));
    feed.close();
  }
}, 120_000);
