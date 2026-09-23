-- This server's connection to a Crewly account, for Crewly-managed services
-- (AI Gateway, Mail, Sign in with Crewly). Optional: absent, the server runs
-- entirely on its own. One row at most -- a server is one principal.
--
-- The credential names this instance and the capabilities its owner granted,
-- never the owner's account. It is encrypted with the server's secret key and
-- never sent to a browser. While linking, the device code waits here instead.
CREATE TABLE crewly_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cloud_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'revoked')),
  device_code_ciphertext TEXT,
  user_code TEXT,
  verification_url TEXT,
  link_expires_at TEXT,
  poll_interval INTEGER,
  instance_id TEXT,
  credential_ciphertext TEXT,
  credential_version INTEGER,
  scopes TEXT NOT NULL DEFAULT '[]',
  connected_at TEXT,
  last_checked_at TEXT,
  updated_at TEXT NOT NULL
);

-- Connecting, scope changes, rotation, revocation and disconnection. Never a
-- credential value.
CREATE TABLE crewly_connection_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX crewly_connection_audit_created_idx ON crewly_connection_audit (created_at);
