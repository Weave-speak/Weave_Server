-- A name a session can be called by.
--
-- The table is keyed by the token's hash, and this server treats the hash of a secret as
-- the secret: the admin table browser refuses to read the column at all. So there was no
-- way for somebody to point at one of their own sessions and say "not that one, sign it
-- out" — the only handle on a row was the one thing that must never leave the machine.
--
-- Existing rows are given an id too. Without it, every device signed in before this
-- migration would be unremovable until it happened to sign in again, which is exactly the
-- device somebody most wants to be rid of.
--
-- Unique as an INDEX rather than a column constraint because SQLite cannot add a UNIQUE
-- column to an existing table.
ALTER TABLE sessions ADD COLUMN id TEXT;

UPDATE sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_id ON sessions(id);
