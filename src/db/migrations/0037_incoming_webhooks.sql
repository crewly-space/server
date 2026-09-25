-- A webhook's secret is only shown when it is created or rotated; the server
-- keeps a hash and therefore cannot leak a usable URL from the database.
CREATE TABLE incoming_webhooks (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX incoming_webhooks_channel_idx ON incoming_webhooks(channel_id, created_at);

-- An external event id makes retries idempotent without putting provider
-- payloads into a second copy of the message history.
CREATE TABLE incoming_webhook_events (
  webhook_id TEXT NOT NULL REFERENCES incoming_webhooks(id) ON DELETE CASCADE,
  external_event_id TEXT NOT NULL,
  message_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (webhook_id, external_event_id)
);
