-- System channels: rooms the SERVER creates for its own purposes — a DM call is the
-- first. Never listed to anyone, joinable only through the machinery that made them
-- (membership still applies on top), deleted by their maker when their purpose ends.
ALTER TABLE channels ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
