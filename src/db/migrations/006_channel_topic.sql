-- One line under the room's name: what this room is for, set by an admin.
ALTER TABLE channels ADD COLUMN topic TEXT NOT NULL DEFAULT '';
