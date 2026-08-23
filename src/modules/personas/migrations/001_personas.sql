-- The library is empty on a fresh server, by design. The previous version shipped a
-- set of game audio, film lines and voice clips that nobody had the right to
-- redistribute, so the mechanism is kept and the contents are not.
CREATE TABLE persona_sounds (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    extension   TEXT    NOT NULL,
    mime        TEXT    NOT NULL,
    bytes       INTEGER NOT NULL,
    uploaded_by TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE persona_choices (
    user_id     TEXT PRIMARY KEY,
    -- Null means silence, which is also what a deleted sound falls back to.
    join_sound  TEXT REFERENCES persona_sounds(id) ON DELETE SET NULL,
    leave_sound TEXT REFERENCES persona_sounds(id) ON DELETE SET NULL
);
