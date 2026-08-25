-- Read markers move to insertion order.
--
-- The (created_at, id) cursor is right for PAGING, where order and filter share the
-- same comparison. For READ MARKERS it hid a bug: ids are random UUIDs, so when two
-- messages share a millisecond, acking the one that arrived last can leave the
-- sibling counted forever — a badge that can never clear. rowid is the insertion
-- order the messages were DELIVERED in, which is what "seen up to here" means.
ALTER TABLE chat_reads ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
