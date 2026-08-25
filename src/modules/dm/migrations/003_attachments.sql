-- Same optional attachment as chat_messages, same server-composed JSON shape.
ALTER TABLE dm_messages ADD COLUMN attachment TEXT;
