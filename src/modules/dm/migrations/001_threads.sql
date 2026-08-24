-- One row per PAIR, not per direction: (user_a, user_b) is stored in canonical order
-- (a < b), so "you messaged me" and "I messaged you" can never become two threads.

CREATE TABLE dm_threads (
    id              TEXT    PRIMARY KEY,
    user_a          TEXT    NOT NULL,
    user_b          TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    -- Denormalised so the rail can order threads by activity without a join per row.
    last_message_at INTEGER,
    UNIQUE (user_a, user_b)
);

CREATE TABLE dm_messages (
    id          TEXT    PRIMARY KEY,
    thread_id   TEXT    NOT NULL,
    author_id   TEXT    NOT NULL,
    -- A snapshot of who they were when they said it, same reasoning as chat_messages.
    author_name TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
);

-- The pagination walk, identical in shape to the channel one: (created_at, id) backwards.
CREATE INDEX idx_dm_thread_created ON dm_messages(thread_id, created_at DESC, id DESC);

-- Same forward-only read marker the channels use, per person per thread.
CREATE TABLE dm_reads (
    user_id         TEXT    NOT NULL,
    thread_id       TEXT    NOT NULL,
    last_created_at INTEGER NOT NULL,
    last_id         TEXT    NOT NULL,
    PRIMARY KEY (user_id, thread_id)
);
