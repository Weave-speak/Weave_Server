-- One row per (message, person, emoji): a toggle is an insert or a delete, an aggregate
-- is a GROUP BY, and there is nothing to keep consistent because nothing is duplicated.
-- This is the Discord-shaped model, minus custom emoji uploads on purpose.
CREATE TABLE chat_reactions (
    message_id TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    emoji      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);

-- History pages aggregate by message; the primary key alone would scan.
CREATE INDEX idx_chat_reactions_message ON chat_reactions (message_id);
