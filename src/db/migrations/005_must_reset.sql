-- An administrator can force a password change without CHOOSING the password: the flag
-- survives until the account's owner picks a new one at their next sign-in.
ALTER TABLE users ADD COLUMN must_reset INTEGER NOT NULL DEFAULT 0;
