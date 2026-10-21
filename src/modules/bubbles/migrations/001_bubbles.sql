-- Bubbles: admin-made photo collections that drift over the chat, each with its own small
-- conversation. Ported from the previous server, where they lived in the one big db.js.
--
-- The photo is stored by this module rather than borrowed from uploads, because uploads are
-- swept after a retention period and a bubble is meant to outlive any of its messages.
CREATE TABLE bubbles (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    extension   TEXT    NOT NULL,
    mime        TEXT    NOT NULL,
    created_by  TEXT,
    created_at  INTEGER NOT NULL
);

-- Shaped like chat_messages, so the same client code reads either. The author's name and
-- face are copied in at the time, because a bubble's history is read long after the people
-- in it have renamed themselves or gone.
CREATE TABLE bubble_messages (
    id          TEXT    PRIMARY KEY,
    bubble_id   TEXT    NOT NULL REFERENCES bubbles(id) ON DELETE CASCADE,
    user_id     TEXT,
    author_name TEXT    NOT NULL,
    avatar      TEXT,
    body        TEXT    NOT NULL,
    attachment  TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_bubble_messages_page ON bubble_messages(bubble_id, created_at, id);

-- Read markers, by insertion order (ROWID) like the channels' — forward-only, so a stale
-- device acking old history cannot bring an unread throb back.
CREATE TABLE bubble_reads (
    user_id   TEXT    NOT NULL,
    bubble_id TEXT    NOT NULL REFERENCES bubbles(id) ON DELETE CASCADE,
    last_seq  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, bubble_id)
);
