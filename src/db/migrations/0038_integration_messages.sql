-- Integration/webhook authors are not users or agents, so they cannot
-- accidentally receive permissions or trigger a conversational DM.
CREATE TABLE messages_rebuilt (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  author_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent', 'integration')),
  body TEXT NOT NULL,
  reply_to_message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL
);

INSERT INTO messages_rebuilt (id, conversation_id, author_id, author_type, body, reply_to_message_id, created_at)
  SELECT id, conversation_id, author_id, author_type, body, reply_to_message_id, created_at FROM messages;

DROP TABLE messages;
ALTER TABLE messages_rebuilt RENAME TO messages;
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at);
