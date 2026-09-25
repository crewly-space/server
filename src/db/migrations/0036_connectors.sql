-- First-class external service connections. The credential is encrypted and
-- never returned from the API; the rest is safe product metadata.
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT,
  account_name TEXT,
  account_url TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'action_required', 'permission_revoked', 'rate_limited', 'provider_unavailable', 'revoked')),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_type TEXT,
  credential_ciphertext TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  last_checked_at TEXT,
  revoked_at TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX connectors_provider_account_idx ON connectors(provider, account_id) WHERE account_id IS NOT NULL AND status <> 'revoked';
CREATE INDEX connectors_owner_idx ON connectors(owner_user_id, created_at);

-- OAuth state is single-use and bound to the signed-in user who started it.
CREATE TABLE connector_oauth_states (
  state TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callback_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX connector_oauth_states_expiry_idx ON connector_oauth_states(expires_at);

-- Connecting a service is separate from allowing an agent or automation to
-- use an action on it.
CREATE TABLE connector_grants (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('agent', 'automation', 'integration')),
  grantee_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, grantee_type, grantee_id, capability)
);

CREATE INDEX connector_grants_grantee_idx ON connector_grants(grantee_type, grantee_id);

-- History deliberately has no foreign key so it survives disconnect/delete.
CREATE TABLE connector_audit (
  id TEXT PRIMARY KEY,
  connector_id TEXT,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'automation', 'integration', 'system')),
  actor_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX connector_audit_connector_idx ON connector_audit(connector_id, created_at);
CREATE INDEX connector_audit_created_idx ON connector_audit(created_at);
