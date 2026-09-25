-- Uploaded files are private conversation resources. The bytes live outside
-- SQLite; this table is the stable metadata and authorization record.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX attachments_message_idx ON attachments(message_id, created_at);
CREATE INDEX attachments_conversation_idx ON attachments(conversation_id, created_at);
