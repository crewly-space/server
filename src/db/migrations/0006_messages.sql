CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  author_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
  body TEXT NOT NULL,
  reply_to_message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_messages_conversation_created ON messages (conversation_id, created_at);

CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('user', 'agent')),
  PRIMARY KEY (message_id, target_id, target_type)
);
