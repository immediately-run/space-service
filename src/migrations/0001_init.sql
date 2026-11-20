-- 0001_init.sql — one space's database (STORE_PORTABILITY_SPEC §5.5.2, §5.5.4).
-- A migration is never edited once merged: a change is a new file and a new entry in index.ts.
--
-- The core's TypeScript is the gate. The triggers below are the second gate (P10): each makes a
-- state the core must never produce unwritable, so a bug in the core fails loudly instead of
-- weakening an invariant.

-- The space itself: exactly one row, written by `create`.
CREATE TABLE space (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,                                                  -- the anchor owner; never changes
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),         -- the soft-delete tombstone
  ever_shared INTEGER NOT NULL DEFAULT 0 CHECK (ever_shared IN (0, 1)), -- the latch; write-once 1
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0)                       -- the last committed changeset
);

CREATE TABLE members (
  uid TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'writer', 'reader'))
);

-- One row per file. `data` is the record's JSON text; `rev` is the seq of the commit that wrote it.
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL CHECK (rev > 0)
);

-- The change log. One committed changeset takes one seq, so its rows share it.
CREATE TABLE changes (
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('put', 'delete')),
  rev INTEGER NOT NULL,
  op_id TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (seq, path)
);

CREATE TRIGGER space_latch_is_write_once BEFORE UPDATE OF ever_shared ON space
WHEN OLD.ever_shared = 1 AND NEW.ever_shared <> 1
BEGIN SELECT RAISE(ABORT, 'ever_shared is write-once'); END;

CREATE TRIGGER space_owner_never_changes BEFORE UPDATE OF owner ON space
WHEN NEW.owner <> OLD.owner
BEGIN SELECT RAISE(ABORT, 'owner never changes'); END;

CREATE TRIGGER space_seq_never_decreases BEFORE UPDATE OF seq ON space
WHEN NEW.seq < OLD.seq
BEGIN SELECT RAISE(ABORT, 'seq never decreases'); END;

CREATE TRIGGER space_row_is_kept BEFORE DELETE ON space
BEGIN SELECT RAISE(ABORT, 'the space row is never deleted'); END;

CREATE TRIGGER files_rev_never_decreases BEFORE UPDATE OF rev ON files
WHEN NEW.rev < OLD.rev
BEGIN SELECT RAISE(ABORT, 'rev never decreases'); END;

-- The anchor owner is always a member, always an owner.
CREATE TRIGGER members_anchor_stays_owner BEFORE UPDATE ON members
WHEN OLD.uid = (SELECT owner FROM space) AND (NEW.uid <> OLD.uid OR NEW.role <> 'owner')
BEGIN SELECT RAISE(ABORT, 'the anchor owner stays an owner'); END;

CREATE TRIGGER members_anchor_stays BEFORE DELETE ON members
WHEN OLD.uid = (SELECT owner FROM space)
BEGIN SELECT RAISE(ABORT, 'the anchor owner stays a member'); END;

-- The latch's other half: a write-capable member besides the anchor owner cannot exist in a
-- space whose latch is unset, so the latch is set in the same transaction or the write fails.
CREATE TRIGGER members_insert_needs_latch BEFORE INSERT ON members
WHEN NEW.role IN ('owner', 'writer') AND NEW.uid <> (SELECT owner FROM space) AND (SELECT ever_shared FROM space) <> 1
BEGIN SELECT RAISE(ABORT, 'a write-capable member needs the latch'); END;

CREATE TRIGGER members_update_needs_latch BEFORE UPDATE ON members
WHEN NEW.role IN ('owner', 'writer') AND NEW.uid <> (SELECT owner FROM space) AND (SELECT ever_shared FROM space) <> 1
BEGIN SELECT RAISE(ABORT, 'a write-capable member needs the latch'); END;
