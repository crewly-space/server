-- Named secrets for the things agents and tools need to authenticate with:
-- MCP credentials, runtime environment, integration tokens. The value is
-- encrypted with the server's secret key and is never returned once stored.
-- Names are what configuration refers to ({{secret:GITHUB_TOKEN}}), so they
-- look like environment variables.
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
    CHECK (length(name) <= 64 AND name GLOB '[A-Z]*' AND name NOT GLOB '*[^A-Z0-9_]*'),
  description TEXT NOT NULL DEFAULT '',
  -- NULL once revoked: the value is gone, the record of it is not.
  ciphertext TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT
);

-- Who may use a secret. Nothing receives a secret it was not granted.
CREATE TABLE secret_grants (
  secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL
    CHECK (grantee_type IN ('agent', 'runtime', 'mcp_server', 'automation', 'integration', 'skill')),
  grantee_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (secret_id, grantee_type, grantee_id)
);

CREATE INDEX secret_grants_grantee_idx ON secret_grants (grantee_type, grantee_id);

-- Every change to a secret, and every time something read one. No foreign
-- key: the history outlives a deleted secret, which is when it matters.
CREATE TABLE secret_audit (
  id TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'mcp_server', 'skill', 'runtime', 'automation', 'integration', 'system')),
  actor_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX secret_audit_secret_idx ON secret_audit (secret_id, created_at);
CREATE INDEX secret_audit_created_idx ON secret_audit (created_at);
