CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  platform TEXT,
  capabilities TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX devices_owner_idx ON devices(owner_user_id);

CREATE TABLE device_pairings (
  id TEXT PRIMARY KEY,
  poll_token_hash TEXT NOT NULL,
  user_code TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  platform TEXT,
  expires_at TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX device_pairings_expiry_idx ON device_pairings(expires_at);
