-- Opting out is a property of the ACCOUNT, not the device. The previous version had
-- the client report a flag on every join, so the exemption lived on one machine and
-- silently stopped applying anywhere else.
CREATE TABLE afk_optouts (
    user_id    TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
