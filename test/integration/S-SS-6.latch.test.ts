// S-SS-6 — the everShared latch (R-STORE-6; §5.5.2): set in the transaction that makes a
// write-capable member, never unset, and backed by the schema's triggers (P10).
import { expect, it } from 'vitest';
import { api, newSpace } from '../lib/harness';
import { withCore } from '#host';

const latch = (spaceId: string) => withCore(spaceId, (core) => core.store.exec<{ ever_shared: number }>('SELECT ever_shared FROM space').one().ever_shared);
/** A raw statement through the Store, as a bug in the core would issue it. */
const raw = (spaceId: string, sql: string, ...params: unknown[]) =>
  withCore(spaceId, (core) => {
    try {
      core.store.exec(sql, ...params).toArray();
      return 'written';
    } catch (e) {
      return String(e);
    }
  });

it('S-SS-6: setRole to a non-owner writer sets the latch in the same transaction, and nothing unsets it', async () => {
  const { spaceId, owner } = await newSpace();
  expect(await latch(spaceId)).toBe(0);
  // A reader does not latch.
  await api(spaceId, owner, 'setRole', { uid: 'user:r', role: 'reader' });
  expect(await latch(spaceId)).toBe(0);
  expect((await api(spaceId, owner, 'members')).body.everShared).toBe(false);

  expect((await api(spaceId, owner, 'setRole', { uid: 'user:w', role: 'writer' })).status).toBe(200);
  expect(await latch(spaceId)).toBe(1);
  expect((await api(spaceId, owner, 'members')).body.everShared).toBe(true);

  // Demoting and removing the writer leaves it set.
  await api(spaceId, owner, 'setRole', { uid: 'user:w', role: 'reader' });
  await api(spaceId, owner, 'unshare', { uid: 'user:w' });
  expect(await latch(spaceId)).toBe(1);

  expect(await raw(spaceId, 'UPDATE space SET ever_shared = 0')).toMatch(/ever_shared is write-once/);
  expect(await latch(spaceId)).toBe(1);
});

it('S-SS-6: the schema refuses a write-capable member without the latch, and the other invariants', async () => {
  const { spaceId, owner } = await newSpace();
  await api(spaceId, owner, 'setRole', { uid: 'user:r', role: 'reader' });
  await api(spaceId, owner, 'put', { path: '/a', data: 1 });
  await api(spaceId, owner, 'put', { path: '/a', data: 2 });

  // The latch cannot be skipped: neither a new writer nor a promoted reader, while it is unset.
  expect(await raw(spaceId, "INSERT INTO members (uid, role) VALUES ('user:x', 'writer')")).toMatch(/needs the latch/);
  expect(await raw(spaceId, "UPDATE members SET role = 'owner' WHERE uid = 'user:r'")).toMatch(/needs the latch/);
  expect(await latch(spaceId)).toBe(0);
  // The other second-gate triggers.
  expect(await raw(spaceId, "UPDATE space SET owner = 'user:r'")).toMatch(/owner never changes/);
  expect(await raw(spaceId, 'UPDATE files SET rev = 1')).toMatch(/rev never decreases/);
  expect(await raw(spaceId, 'UPDATE space SET seq = 0')).toMatch(/seq never decreases/);
  expect(await raw(spaceId, 'DELETE FROM space')).toMatch(/never deleted/);
  expect(await raw(spaceId, "DELETE FROM members WHERE uid = 'user:owner'")).toMatch(/anchor owner/);
  expect(await raw(spaceId, "UPDATE members SET role = 'reader' WHERE uid = 'user:owner'")).toMatch(/anchor owner/);
  expect(await raw(spaceId, "INSERT INTO members (uid, role) VALUES ('user:y', 'admin')")).toMatch(/constraint/i);
});
