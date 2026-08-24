-- Private channels: rooms whose OCCUPANTS are a secret kept from non-members.
--
-- The columns live in core, not in the module, on purpose: secrecy must not depend on a
-- module being enabled. Disabling the private-channels module stops creation and expiry;
-- it must never expose who is standing in an existing private room.

ALTER TABLE channels ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN created_by TEXT;
-- Seeded at creation and stamped on every occupancy change; the reaper deletes a private
-- channel that has stood EMPTY past the configured window, measured from here.
ALTER TABLE channels ADD COLUMN last_occupied_at INTEGER;

CREATE TABLE channel_members (
    channel_id TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    added_by   TEXT,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
);

-- The visibility check runs per viewer on every roster event.
CREATE INDEX idx_members_user ON channel_members(user_id, channel_id);
