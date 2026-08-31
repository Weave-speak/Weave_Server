-- Moderation: an administrator silencing or ejecting someone, in a way a refresh cannot
-- undo.
--
-- One table for both verbs rather than two, because a kick's cooldown IS a short-lived
-- restriction with an expiry — the same shape as a timed mute, and giving it its own table
-- would mean two sweeps and two "is this still in force?" queries that could disagree.
--
-- The columns live in core rather than in a module for the same reason private channels do:
-- the server is authoritative, and a silencing that stops being enforced because a feature
-- was switched off is not a silencing. It is a suggestion.
--
-- expires_at is epoch milliseconds like sessions and invites, because it is compared in
-- code on every join; at is readable text like audit_log, because it is only ever read by
-- a person.
CREATE TABLE moderation (
    id          TEXT    PRIMARY KEY,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action      TEXT    NOT NULL,      -- 'mute' | 'kick'
    reason      TEXT,
    by_user_id  TEXT    REFERENCES users(id) ON DELETE SET NULL,
    at          TEXT    NOT NULL DEFAULT (datetime('now')),
    -- NULL on a mute means "until an administrator lifts it". A kick always has one: that
    -- is the cooldown, and it is what stops a kick being theatre the client undoes by
    -- reconnecting a second later.
    expires_at  INTEGER,
    lifted_at   INTEGER,
    lifted_by   TEXT    REFERENCES users(id) ON DELETE SET NULL
);

-- Every join asks "is this account restricted?", so the lookup is by user and action with
-- the lifted ones already excluded.
CREATE INDEX idx_moderation_active ON moderation(user_id, action, lifted_at);
