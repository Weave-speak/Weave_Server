-- Same monotonic read cursor as chat_reads, for the same reason: random-UUID ids
-- cannot tiebreak a same-millisecond pair, and the unread badge must always be
-- able to reach zero.
ALTER TABLE dm_reads ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
