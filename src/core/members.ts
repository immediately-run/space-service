// members.ts — who may do what in a space (STORE_PORTABILITY_SPEC §5.5.2; R-STORE-5, R-STORE-6).
// The space's own database is the only authority: every decision that grants anything reads
// these tables in the turn that acts on it. Each mutation is one transaction, the `everShared`
// latch included — there is no trigger outside the database and no second store to disagree.
import type { Store } from './ports';
import { ROLE, canWrite, type Role } from './protocol';

export interface SpaceRow {
  owner: string;
  deleted: number;
  ever_shared: number;
  seq: number;
}

/** The space's row, or null before `create`. */
export function spaceRow(store: Store): SpaceRow | null {
  return store.exec<SpaceRow>('SELECT owner, deleted, ever_shared, seq FROM space').toArray()[0] ?? null;
}

/**
 * The role `uid` holds right now, or null: no space, a tombstoned space and no membership are
 * one answer (P7).
 */
export function roleOf(store: Store, uid: string): Role | null {
  const space = spaceRow(store);
  if (!space || space.deleted) return null;
  return store.exec<{ role: Role }>('SELECT role FROM members WHERE uid = ?', uid).toArray()[0]?.role ?? null;
}

/** Create the space with `uid` as its anchor owner. False when it already exists. */
export function create(store: Store, uid: string): boolean {
  return store.transaction(() => {
    if (spaceRow(store)) return false;
    store.exec('INSERT INTO space (id, owner) VALUES (1, ?)', uid).toArray();
    store.exec('INSERT INTO members (uid, role) VALUES (?, ?)', uid, ROLE.owner).toArray();
    return true;
  });
}

export function list(store: Store): { uid: string; role: Role }[] {
  return store.exec<{ uid: string; role: Role }>('SELECT uid, role FROM members ORDER BY uid').toArray();
}

/** What a membership change did to one uid's authority, for the feed to push in the same turn. */
export type Effect = { uid: string; role: Role } | { uid: string; role: null };

/**
 * Grant `uid` a role, or change the one it holds. The latch is set in this transaction whenever
 * the result is a write-capable member other than the anchor owner; it is never unset.
 * Returns the effect, null when nothing changed, or 'anchor' for a change to the anchor owner.
 */
export function setRole(store: Store, uid: string, role: Role): Effect | null | 'anchor' {
  return store.transaction(() => {
    const space = spaceRow(store)!;
    if (uid === space.owner) return role === ROLE.owner ? null : 'anchor';
    const current = store.exec<{ role: Role }>('SELECT role FROM members WHERE uid = ?', uid).toArray()[0]?.role ?? null;
    if (current === role) return null;
    if (canWrite(role)) store.exec('UPDATE space SET ever_shared = 1').toArray();
    store.exec('INSERT INTO members (uid, role) VALUES (?, ?) ON CONFLICT (uid) DO UPDATE SET role = excluded.role', uid, role).toArray();
    return { uid, role };
  });
}

/** Remove `uid`'s membership. Null when it held none; 'anchor' for the anchor owner. */
export function unshare(store: Store, uid: string): Effect | null | 'anchor' {
  return store.transaction(() => {
    if (uid === spaceRow(store)!.owner) return 'anchor';
    const held = store.exec('SELECT 1 AS x FROM members WHERE uid = ?', uid).toArray().length > 0;
    if (!held) return null;
    store.exec('DELETE FROM members WHERE uid = ?', uid).toArray();
    return { uid, role: null };
  });
}

/** Tombstone the space: from here every read, write and hello is forbidden, for everyone. */
export function softDelete(store: Store): void {
  store.exec('UPDATE space SET deleted = 1').toArray();
}
