-- A "tester" is an ordinary account with one extra thing switched on: the in-app
-- stream-quality reporting controls. It is deliberately its own flag rather than being
-- folded into is_admin, so an operator can hand someone the diagnostics buttons without
-- handing them the keys to the server. Granted and revoked from user management, exactly
-- like is_admin, and defaulting off so every existing account stays as it was.
ALTER TABLE users ADD COLUMN is_tester INTEGER NOT NULL DEFAULT 0;
