-- When a person's digest goes out. Absent means the default: daily at 08:00 UTC.
-- Frequency plus hour (and weekday for weekly) is the whole schedule model;
-- a new frequency is a new value here, not a new table.
CREATE TABLE notification_digest_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly')),
  hour_utc INTEGER NOT NULL CHECK (hour_utc BETWEEN 0 AND 23),
  weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),
  updated_at TEXT NOT NULL
);

-- Every digest sent, one per person and scheduled time: the unique key is
-- what stops a slot being sent twice.
CREATE TABLE notification_digests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_end TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  mail_delivery_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, period_end)
);
