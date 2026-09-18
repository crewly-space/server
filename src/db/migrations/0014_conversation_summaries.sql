CREATE TABLE conversation_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  summary TEXT NOT NULL,
  up_to_message_id TEXT NOT NULL REFERENCES messages(id),
  updated_at TEXT NOT NULL
);
