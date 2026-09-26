-- Unified execution policy. A NULL agent_id is the server default; the most
-- specific matching per-agent rule wins. Scope is structured JSON so paths,
-- domains, MCP tools, secrets, and future capability targets share one model.
CREATE TABLE capability_policies (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  scope TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX capability_policies_agent_idx ON capability_policies(agent_id, capability);

ALTER TABLE approvals ADD COLUMN capability TEXT;
ALTER TABLE approvals ADD COLUMN action_hash TEXT;
ALTER TABLE approvals ADD COLUMN expires_at TEXT;
CREATE UNIQUE INDEX approvals_pending_action_idx ON approvals(run_id, action_hash)
  WHERE status = 'pending' AND action_hash IS NOT NULL;

-- Optional Crewly Identity for a self-hosted server. Local authentication is
-- always retained for owner recovery and may coexist with Crewly Identity.
CREATE TABLE auth_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'local' CHECK (mode IN ('local', 'crewly', 'both')),
  crewly_enabled INTEGER NOT NULL DEFAULT 0 CHECK (crewly_enabled IN (0, 1)),
  handoff_public_key TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO auth_settings (id, mode, crewly_enabled, updated_at)
VALUES (1, 'local', 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE crewly_identity_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  invite_token TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Slack import keeps provider ids so retries update or skip instead of
-- duplicating local channels/messages/invitations.
CREATE TABLE slack_imports (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'completed_with_errors', 'failed')),
  options TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE slack_import_mappings (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  remote_type TEXT NOT NULL CHECK (remote_type IN ('channel', 'message', 'member')),
  remote_id TEXT NOT NULL,
  local_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'matched', 'skipped', 'failed')),
  detail TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, remote_type, remote_id)
);

-- Federation is disabled until two administrators explicitly establish a
-- mutually authenticated, scoped connection.
CREATE TABLE federation_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  display_name TEXT NOT NULL DEFAULT 'Crewly server',
  updated_at TEXT NOT NULL
);

CREATE TABLE federation_connections (
  id TEXT PRIMARY KEY,
  remote_url TEXT NOT NULL,
  remote_server_id TEXT,
  remote_connection_id TEXT,
  remote_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'unreachable', 'incompatible')),
  scopes TEXT NOT NULL DEFAULT '[]',
  local_secret_ciphertext TEXT,
  remote_secret_ciphertext TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX federation_remote_idx ON federation_connections(remote_url) WHERE status <> 'revoked';

CREATE TABLE federation_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES federation_connections(id) ON DELETE SET NULL,
  origin_server_id TEXT NOT NULL,
  causation_id TEXT,
  event_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  hop_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('accepted', 'delivered', 'duplicate', 'rejected', 'failed')),
  created_at TEXT NOT NULL
);

CREATE INDEX federation_events_connection_idx ON federation_events(connection_id, created_at);

-- First-party browser sessions are bounded and ephemeral by default. Browser
-- action payloads stay out of traces; traces store only action metadata.
CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'expired', 'failed')),
  persistent INTEGER NOT NULL DEFAULT 0 CHECK (persistent IN (0, 1)),
  page_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  last_error TEXT
);

CREATE TABLE browser_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'denied', 'failed')),
  artifact_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX browser_actions_session_idx ON browser_actions(session_id, created_at);

-- Registry metadata and installations never store credential values. Private
-- registries can be selected by server owners; public discovery is opt-in.
CREATE TABLE registry_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  registry_url TEXT,
  allow_unverified INTEGER NOT NULL DEFAULT 0 CHECK (allow_unverified IN (0, 1)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO registry_settings (id, enabled, allow_unverified, updated_at)
VALUES (1, 0, 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE registry_installations (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('skill', 'mcp_preset')),
  registry_id TEXT NOT NULL,
  name TEXT NOT NULL,
  publisher TEXT NOT NULL,
  version TEXT NOT NULL,
  pinned_version TEXT,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  manifest TEXT NOT NULL,
  installed_resource_id TEXT,
  installed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_type, registry_id)
);

-- Threads are rooted in one channel message and inherit that channel's
-- permissions. Replies remain ordinary messages, keeping realtime/search and
-- agent execution on the existing message path.
CREATE TABLE message_threads (
  root_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'archived')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  archived_at TEXT
);

CREATE TABLE message_thread_reads (
  root_message_id TEXT NOT NULL REFERENCES message_threads(root_message_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (root_message_id, user_id)
);

ALTER TABLE messages ADD COLUMN thread_root_id TEXT REFERENCES messages(id) ON DELETE CASCADE;
CREATE INDEX messages_thread_idx ON messages(thread_root_id, created_at);
