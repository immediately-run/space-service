// files.ts — file records and the change log (STORE_PORTABILITY_SPEC §5.5.3, §5.5.4; R-STORE-1,
// R-STORE-4). Every write is a changeset: `put` and `delete` are changesets of one. A changeset
// commits whole or not at all, takes exactly one `seq`, and writes its log rows in the same
// transaction as the files — so a rename is one delta to every observer.
import type { Store } from './ports';
import { FEED_RETENTION, OP, SNAPSHOT_FRAME_BYTES, byteLength, type Change, type DeltaChange } from './protocol';

export type CommitResult =
  /** Committed. `changes` is empty when nothing changed (deleting what was not there). */
  | { seq: number; changes: DeltaChange[] }
  /** A `basedOn` was stale. Nothing was written. */
  | { conflict: string[] };

/** The last committed changeset's seq; 0 before the first. */
export const head = (store: Store): number => store.exec<{ seq: number }>('SELECT seq FROM space').one().seq;

/** A path's current rev; 0 when it holds no file. */
function revOf(store: Store, path: string): number {
  return store.exec<{ rev: number }>('SELECT rev FROM files WHERE path = ?', path).toArray()[0]?.rev ?? 0;
}

/**
 * Apply `changes` atomically. Each `basedOn` must equal its path's current rev (0: no file);
 * without one the write is unconditional, last writer wins. A file's new rev is the commit's
 * seq, so a rev is never reused on a path, even across a delete.
 */
export function commit(store: Store, changes: Change[], opId: string | undefined, now: number): CommitResult {
  return store.transaction(() => {
    const before = new Map<string, number>();
    const stale: string[] = [];
    for (const c of changes) {
      const rev = revOf(store, c.path);
      before.set(c.path, rev);
      if (c.basedOn !== undefined && c.basedOn !== rev) stale.push(c.path);
    }
    if (stale.length) return { conflict: stale };

    const effective = changes.filter((c) => c.op === OP.put || before.get(c.path) !== 0);
    if (!effective.length) return { seq: head(store), changes: [] };

    const seq = head(store) + 1;
    for (const c of effective) {
      if (c.op === OP.put) {
        store.exec('INSERT INTO files (path, data, rev) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET data = excluded.data, rev = excluded.rev', c.path, c.data, seq).toArray();
      } else {
        store.exec('DELETE FROM files WHERE path = ?', c.path).toArray();
      }
      store.exec('INSERT INTO changes (seq, path, op, rev, op_id, ts) VALUES (?, ?, ?, ?, ?, ?)', seq, c.path, c.op, seq, opId ?? null, now).toArray();
    }
    store.exec('UPDATE space SET seq = ?', seq).toArray();
    store.exec('DELETE FROM changes WHERE seq <= ?', seq - FEED_RETENTION).toArray();
    // The delta is read back from the log, so the live frame and a replayed one are the same.
    return { seq, changes: store.exec<DeltaChange>('SELECT path, op, rev FROM changes WHERE seq = ? ORDER BY path', seq).toArray() };
  });
}

/** One file, or null. `data` is its JSON text. */
export function read(store: Store, path: string): { data: string; rev: number } | null {
  return store.exec<{ data: string; rev: number }>('SELECT data, rev FROM files WHERE path = ?', path).toArray()[0] ?? null;
}

export interface LoggedDelta {
  seq: number;
  changes: DeltaChange[];
  opId: string | null;
}

/**
 * The deltas after `sinceSeq`, in order — or null when the log no longer reaches back that far
 * (or `sinceSeq` is ahead of the space), and the caller must send a snapshot instead.
 */
export function deltasSince(store: Store, sinceSeq: number): LoggedDelta[] | null {
  const seq = head(store);
  if (sinceSeq > seq || sinceSeq < seq - FEED_RETENTION) return null;
  const rows = store.exec<{ seq: number; path: string; op: DeltaChange['op']; rev: number; op_id: string | null }>('SELECT seq, path, op, rev, op_id FROM changes WHERE seq > ? ORDER BY seq, path', sinceSeq).toArray();
  const out: LoggedDelta[] = [];
  for (const r of rows) {
    let last = out[out.length - 1];
    if (!last || last.seq !== r.seq) out.push((last = { seq: r.seq, changes: [], opId: r.op_id }));
    last.changes.push({ path: r.path, op: r.op, rev: r.rev });
  }
  return out;
}

export type StoredDoc = { path: string; data: string; rev: number };

/**
 * Every file, in path order, in groups sized for one snapshot frame each — at least one group,
 * read and yielded a bounded step at a time, so neither a statement nor a frame holds the whole
 * space. The caller consumes it within one turn.
 */
export function* snapshotPages(store: Store): Generator<StoredDoc[]> {
  let page: StoredDoc[] = [];
  let bytes = 0;
  let after = '';
  for (;;) {
    const rows = store.exec<StoredDoc>('SELECT path, data, rev FROM files WHERE path > ? ORDER BY path LIMIT 64', after).toArray();
    if (!rows.length) break;
    for (const doc of rows) {
      const size = byteLength(doc.data);
      if (page.length && bytes + size > SNAPSHOT_FRAME_BYTES) {
        yield page;
        page = [];
        bytes = 0;
      }
      page.push(doc);
      bytes += size;
    }
    after = rows[rows.length - 1].path;
  }
  yield page;
}
