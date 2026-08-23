-- Messages belong to the text-chat module, not the core, so a server that never enables
-- it never grows these tables — and disabling it leaves them untouched rather than
-- destroying anyone's history.

CREATE TABLE chat_messages (
    id          TEXT    PRIMARY KEY,
    channel_id  TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    -- Author name and avatar are denormalised on purpose. History has to render for a
    -- poster who has since left, and a join against a deleted user would blank the
    -- message. This is a snapshot of who they were when they said it.
    author_name TEXT    NOT NULL,
    avatar      TEXT,
    body        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    edited_at   INTEGER
);

-- Pagination walks backwards through a channel by id, so this is the index the real
-- query uses. The previous schema indexed (channel_id, created_at) while paginating on
-- rowid, so the index never served the query it was created for.
CREATE INDEX idx_chat_channel_created ON chat_messages(channel_id, created_at DESC, id DESC);

-- Retention sweeps by age across every channel.
CREATE INDEX idx_chat_created ON chat_messages(created_at);
