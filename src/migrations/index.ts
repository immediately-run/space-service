// The numbered schema migrations, applied in order before a space serves. A migration is never
// edited once merged: a change is a new file and a new entry here.
import init from './0001_init.sql';

export const MIGRATIONS: { version: number; sql: string }[] = [{ version: 1, sql: init }];
