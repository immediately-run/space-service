// db.ts — schema migrations, applied in order before a space serves.
import type { Store } from './ports';
import { MIGRATIONS } from '../migrations/index';

export function migrate(store: Store): void {
  store.script('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
  const done = new Set(store.exec<{ version: number }>('SELECT version FROM schema_migrations').toArray().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    store.transaction(() => {
      store.script(m.sql);
      store.exec('INSERT INTO schema_migrations (version) VALUES (?)', m.version).toArray();
    });
  }
}
