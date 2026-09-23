-- In-app notifications: what a person sees in their feed.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at);

-- A person's choice per event type and channel. Absent means the default.
-- Mandatory events (security, account) are never read from here.
CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email')),
  mode TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_type, channel)
);

-- One row per event, recipient and channel: the unique key is what makes a
-- retried event a no-op. The payload (which may hold a sign-in link) is
-- encrypted and dropped once delivered.
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email')),
  collapse_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  mail_delivery_id TEXT,
  payload_ciphertext TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (dedupe_key, recipient, channel)
);

CREATE INDEX notification_deliveries_collapse_idx ON notification_deliveries (recipient, channel, event_type, collapse_key, created_at);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (status, next_attempt_at);
