-- How this server sends email. One row at most; absent means disabled.
--
-- `config` holds only what is safe to show (SMTP host, port, username). The
-- password or API key is encrypted with the server's secret key and never
-- returned by the API.
CREATE TABLE mail_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider IN ('disabled', 'crewly', 'smtp', 'resend', 'postmark')),
  from_address TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  secret_ciphertext TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

-- Every message the server tried to send, whichever provider it went through.
-- The message itself (which may carry a sign-in link) is encrypted, and only
-- kept while it may still be retried.
CREATE TABLE mail_deliveries (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  category TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload_ciphertext TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'retrying', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  last_error TEXT,
  provider_message_id TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX mail_deliveries_due_idx ON mail_deliveries (status, next_attempt_at);
CREATE INDEX mail_deliveries_created_idx ON mail_deliveries (created_at);
