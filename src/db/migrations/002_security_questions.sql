-- Recovery moves from a free-text passphrase to a chosen question plus an answer.
--
-- The answer lives in the existing recovery_hash column: it is still a hashed secret
-- compared in constant time, only its meaning changes. Adding the question id beside it
-- is what makes a two-step reset possible — ask the question, then accept the answer.
--
-- recovery_question is nullable because accounts created before this migration have a
-- passphrase and no question. They keep working: recovery falls back to treating the
-- stored hash as a passphrase when no question is set.
ALTER TABLE users ADD COLUMN recovery_question TEXT;

-- Per-installation salt for the decoy questions shown for usernames that do not exist.
-- Without a salt, the same username would map to the same question on every Weave server
-- in the world, which would let someone confirm an account by comparing two servers.
INSERT INTO settings (key, value)
VALUES ('core.recoverySalt', json_quote(hex(randomblob(16))))
ON CONFLICT(key) DO NOTHING;
