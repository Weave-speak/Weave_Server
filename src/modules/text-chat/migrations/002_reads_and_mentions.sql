-- Reading is decoupled from being somewhere: any member can open any text channel, so the
-- server has to answer "what have I not seen" per channel per person — that is what the
-- unread badge and the mention bell are made of, and keeping it here means it follows the
-- account rather than one machine's local storage.

CREATE TABLE chat_reads (
    user_id         TEXT    NOT NULL,
    channel_id      TEXT    NOT NULL,
    -- The same compound cursor pagination uses: the timestamp is the marker, the id
    -- breaks same-millisecond ties, so a burst can never leave a message half-read.
    last_created_at INTEGER NOT NULL,
    last_id         TEXT    NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);

-- Who each message names, resolved once at insert time against the users that existed
-- then. Resolving at read time would re-run a LIKE over history for every unread count,
-- and would retroactively change who "was mentioned" when usernames change hands.
CREATE TABLE chat_mentions (
    message_id TEXT    NOT NULL,
    channel_id TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
);

-- The unread-mentions count walks (user, channel, newer-than-marker).
CREATE INDEX idx_mentions_user_channel ON chat_mentions(user_id, channel_id, created_at);
