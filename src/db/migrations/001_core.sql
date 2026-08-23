-- Core schema.
--
-- Modules create their own tables through their own namespaced migrations; nothing
-- feature-specific belongs here. Foreign keys are enabled at connection time, so the
-- references below are enforced rather than decorative.

CREATE TABLE users (
    id              TEXT    PRIMARY KEY,
    username        TEXT    NOT NULL,
    -- Case-insensitive uniqueness: "Ghost" and "ghost" must not be two accounts,
    -- because people will read a username aloud and type it back differently.
    username_lower  TEXT    NOT NULL UNIQUE,
    display_name    TEXT    NOT NULL,
    password_hash   TEXT    NOT NULL,
    -- argon2id, like the password. The previous schema stored this in clear text and
    -- compared it with !==, which is both a disclosure and a timing oracle.
    recovery_hash   TEXT,
    avatar          TEXT,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    is_disabled     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at    TEXT
);

CREATE TABLE sessions (
    -- SHA-256 of the token, never the token. A stolen database must not yield live
    -- sessions.
    token_hash  TEXT    PRIMARY KEY,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL DEFAULT 'client',   -- 'client' (bearer) | 'admin' (cookie)
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at  INTEGER NOT NULL,
    last_used_at INTEGER,
    user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE invites (
    code          TEXT    PRIMARY KEY,
    created_by    TEXT    REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at    INTEGER,
    max_uses      INTEGER NOT NULL DEFAULT 1,
    uses          INTEGER NOT NULL DEFAULT 0,
    note          TEXT
);
CREATE INDEX idx_invites_creator ON invites(created_by);

CREATE TABLE invite_redemptions (
    code        TEXT    NOT NULL REFERENCES invites(code) ON DELETE CASCADE,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redeemed_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (code, user_id)
);

-- Channels are data, not a hardcoded array compiled into the client. That is what lets
-- an administrator rename or add one without a client release.
CREATE TABLE channels (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    kind        TEXT    NOT NULL DEFAULT 'voice',   -- 'voice' | 'text' | 'both' | 'afk'
    position    INTEGER NOT NULL DEFAULT 0,
    -- Capabilities are explicit rather than inferred from an id prefix. The old server
    -- decided "is this the AFK channel" by string-matching the id, which meant
    -- behaviour was tied to a name someone might reasonably want to change.
    allow_voice INTEGER NOT NULL DEFAULT 1,
    allow_text  INTEGER NOT NULL DEFAULT 1,
    allow_video INTEGER NOT NULL DEFAULT 1,
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_channels_position ON channels(position);

CREATE TABLE settings (
    key         TEXT    PRIMARY KEY,
    value       TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT    NOT NULL DEFAULT (datetime('now')),
    actor_id    TEXT    REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT    NOT NULL,
    target      TEXT,
    detail      TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
