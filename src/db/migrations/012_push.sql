-- Web Push: where to reach a device whose app is not running, and who we are when we do.
--
-- A subscription hangs off the SESSION that registered it, not just the account. Every way
-- a session ends — signing out, being signed out from another device, an administrator's
-- sign-out-everywhere, a password reset, plain expiry — is a DELETE on sessions, and with
-- foreign keys on (db/index.js) that DELETE takes the subscription with it. A phone that
-- has been signed out must never ring again, and this way nothing has to remember to stop
-- it.
--
-- One per session: one session is one signed-in app on one device. The endpoint is unique
-- because the same phone signing in again presents the same one, and must move rather
-- than ring twice.
CREATE TABLE push_subscriptions (
    id            TEXT    PRIMARY KEY,
    session_hash  TEXT    NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint      TEXT    NOT NULL UNIQUE,
    p256dh        TEXT    NOT NULL,
    auth          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    last_ok_at    INTEGER
);
CREATE UNIQUE INDEX push_subscriptions_session ON push_subscriptions(session_hash);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- A session a device rings on idles for longer than the 12-hour default (auth/index.js).
-- NULL is the default window. A phone that must ring while Weave is closed has to stay
-- signed in while closed, as a messaging app does; otherwise one night in a drawer expires
-- its session, the subscription cascades away with it, and it silently stops ringing.
ALTER TABLE sessions ADD COLUMN idle_ttl_ms INTEGER;

-- The longer window belongs to having a subscription, so losing one by ANY path (moved to
-- a new session, dropped by the distributor, the per-account cap, the table browser) puts
-- the session back on the default window. auth/index.js then measures it from last use.
CREATE TRIGGER push_subscription_removed AFTER DELETE ON push_subscriptions
BEGIN
    UPDATE sessions SET idle_ttl_ms = NULL WHERE token_hash = OLD.session_hash;
END;

-- The server's VAPID key pair (RFC 8292), made once on the first start that needs it.
-- A push service may tie a subscription to the key it was made with, so changing this
-- strands every subscribed device until it registers again: it is generated, never
-- rotated by accident. One row, enforced.
CREATE TABLE push_vapid (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    public_key   TEXT    NOT NULL,
    private_key  TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
);
