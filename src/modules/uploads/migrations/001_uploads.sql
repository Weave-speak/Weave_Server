-- Uploads belong to this module, so a server that never enables it never grows the
-- table, and disabling it leaves stored files and rows untouched.

CREATE TABLE uploads (
    id           TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL,
    -- Kept separate from the id so the served URL never contains a name the uploader
    -- chose. A filename is attacker-controlled text.
    extension    TEXT    NOT NULL,
    mime         TEXT    NOT NULL,
    bytes        INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_uploads_created ON uploads(created_at);
CREATE INDEX idx_uploads_user ON uploads(user_id);
