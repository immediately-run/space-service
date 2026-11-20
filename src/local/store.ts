// store.ts — `node:sqlite` as the core's Store: synchronous like the Durable Object's SQLite, so
// the core runs unchanged. Transactions nest as savepoints, as the object's `transactionSync`
// does; integers come back as numbers and blobs as ArrayBuffers, as the object returns them.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Cursor, Row, SqlValue, Store } from '../core/ports';

function cursor<T>(rows: T[]): Cursor<T> {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
  };
}

const toSqlite = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
function fromSqlite(v: unknown): SqlValue {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  return v as SqlValue;
}

export function sqliteStore(db: DatabaseSync): Store {
  const statements = new Map<string, StatementSync>();
  let depth = 0;
  return {
    exec<T = Row>(query: string, ...params: unknown[]): Cursor<T> {
      let stmt = statements.get(query);
      if (!stmt) {
        stmt = db.prepare(query);
        stmt.setReadBigInts(true);
        statements.set(query, stmt);
      }
      const rows = stmt.all(...(params.map(toSqlite) as never[])).map((r) => {
        const out: Row = {};
        for (const [k, v] of Object.entries(r)) out[k] = fromSqlite(v);
        return out as T;
      });
      return cursor(rows);
    },
    script(sql: string): void {
      db.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      const name = `space_tx_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

/**
 * One space's database at `path` (`:memory:` for a throwaway one). A file is held exclusively
 * for the process's life: one host per data directory, as a Durable Object is one instance, so
 * a second process on the same file fails instead of serving beside the first.
 */
export function openStore(path: string): { db: DatabaseSync; store: Store } {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    try {
      db.exec('PRAGMA busy_timeout = 0');
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('BEGIN IMMEDIATE; COMMIT');
    } catch (e) {
      db.close();
      if (/locked|busy/i.test(String(e))) throw new Error(`${path} is in use by another space service`);
      throw e;
    }
  }
  return { db, store: sqliteStore(db) };
}
