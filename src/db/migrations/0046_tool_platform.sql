-- The tool platform: one normalized tool model over native connectors and MCP
-- servers, with per-tool policies, an execution audit, and approvals that can
-- carry the exact call they are asking about.

-- MCP servers become full connections: who owns them, how far to trust them,
-- what they told us about themselves, and whether they currently work.
-- owner_user_id NULL is a workspace connection every admin manages.
ALTER TABLE mcp_servers ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
-- The provider this server speaks for ('github', 'sentry'), when known, so its
-- tools share one namespace and one risk profile with the native connector.
ALTER TABLE mcp_servers ADD COLUMN provider TEXT;
ALTER TABLE mcp_servers ADD COLUMN trust TEXT NOT NULL DEFAULT 'unverified'
  CHECK (trust IN ('official', 'verified', 'community', 'unverified'));
ALTER TABLE mcp_servers ADD COLUMN registry_id TEXT;
-- initialize's serverInfo, protocol version, capabilities and instructions.
ALTER TABLE mcp_servers ADD COLUMN server_info TEXT NOT NULL DEFAULT '{}';
ALTER TABLE mcp_servers ADD COLUMN resources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mcp_servers ADD COLUMN prompts TEXT NOT NULL DEFAULT '[]';
-- Encrypted OAuth client and tokens for servers that sign in with OAuth.
ALTER TABLE mcp_servers ADD COLUMN oauth TEXT;
ALTER TABLE mcp_servers ADD COLUMN health TEXT NOT NULL DEFAULT 'unknown'
  CHECK (health IN ('unknown', 'connected', 'degraded', 'expired', 'error'));
ALTER TABLE mcp_servers ADD COLUMN last_success_at TEXT;
ALTER TABLE mcp_servers ADD COLUMN last_error_at TEXT;
ALTER TABLE mcp_servers ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- What was installed from the Crewly catalog was reviewed here.
UPDATE mcp_servers SET trust = 'verified'
  WHERE id IN (SELECT installed_resource_id FROM registry_installations WHERE item_type = 'mcp_preset' AND verified = 1);
UPDATE mcp_servers SET health = CASE
  WHEN last_error IS NOT NULL THEN 'error'
  WHEN last_tested_at IS NOT NULL THEN 'connected'
  ELSE 'unknown' END;

-- Single-use OAuth state for signing an MCP server in.
CREATE TABLE mcp_oauth_states (
  state TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX mcp_oauth_states_expiry_idx ON mcp_oauth_states(expires_at);

-- How an agent may use a tool once it has been given it. A NULL agent_id is
-- the workspace default. The selector picks tools by exact reference
-- ('github.create_pull_request'), permission ('pull_request:merge'), risk
-- class ('financial') or connection. The most specific match wins.
CREATE TABLE tool_policies (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  selector_type TEXT NOT NULL CHECK (selector_type IN ('tool', 'permission', 'risk', 'connection')),
  selector TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('always', 'ask_once', 'ask_every_time', 'blocked')),
  -- The skill whose authorization set this rule, if any.
  source_skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tool_policies_selector_idx ON tool_policies (COALESCE(agent_id, ''), selector_type, selector);

-- "Ask once": the first approval for an agent and tool is remembered.
CREATE TABLE tool_approval_memory (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_ref TEXT NOT NULL,
  approval_id TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, tool_ref)
);

-- Every external tool execution, and every one refused. Arguments are stored
-- with secrets redacted; results only as metadata. No foreign keys: the
-- record outlives the agent, the connection and the skill.
CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  agent_id TEXT,
  user_id TEXT,
  run_id TEXT,
  conversation_id TEXT,
  skill_id TEXT,
  connection_kind TEXT NOT NULL CHECK (connection_kind IN ('connector', 'mcp_server')),
  connection_id TEXT NOT NULL,
  provider TEXT,
  tool_ref TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  risk TEXT NOT NULL,
  permission TEXT,
  arguments TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'blocked', 'approval_required')),
  policy_mode TEXT,
  approval_id TEXT,
  result_meta TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX tool_executions_created_idx ON tool_executions(created_at);
CREATE INDEX tool_executions_agent_idx ON tool_executions(agent_id, created_at);
CREATE INDEX tool_executions_connection_idx ON tool_executions(connection_id, created_at);
CREATE INDEX tool_executions_run_idx ON tool_executions(run_id);

-- Approvals: who decided, and for a tool approval, the exact call (encrypted)
-- so approving executes it, and what that execution returned.
ALTER TABLE approvals ADD COLUMN resolved_by TEXT;
ALTER TABLE approvals ADD COLUMN tool_call TEXT;
ALTER TABLE approvals ADD COLUMN execution TEXT;

-- Skills declare what they need: capabilities with interchangeable providers,
-- the permissions they use, and the ones that must always ask.
ALTER TABLE skills ADD COLUMN requirements TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_skills ADD COLUMN authorized_at TEXT;
ALTER TABLE agent_skills ADD COLUMN authorized_by TEXT;

-- Which skill authorization gave an agent a tool, so the audit can say so.
ALTER TABLE agent_mcp_tools ADD COLUMN source_skill_id TEXT;
ALTER TABLE connector_grants ADD COLUMN source_skill_id TEXT;
