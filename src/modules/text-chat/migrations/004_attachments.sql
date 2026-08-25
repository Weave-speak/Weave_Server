-- One optional attachment per message, stored as JSON the server itself composed
-- (id, url, mime, bytes, name). The URL is derived from the id at send time, never
-- taken from the client, so a stored attachment can only ever point into /api/uploads.
ALTER TABLE chat_messages ADD COLUMN attachment TEXT;
