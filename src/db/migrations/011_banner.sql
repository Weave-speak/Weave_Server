-- A banner: the wide picture behind a person's name on their profile card.
--
-- An id, exactly like `avatar`: the file lives in the avatars directory and is served by
-- the same route, because both are pictures a person owns about themselves and neither may
-- sit in uploads/, which is swept on a retention timer. NULL is "none", which is what every
-- existing account has until its owner chooses one.
ALTER TABLE users ADD COLUMN banner TEXT;
