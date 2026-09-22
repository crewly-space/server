-- MCP servers an admin has connected, and which of their tools each agent may use.
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL CHECK (transport IN ('http', 'stdio')),
  url TEXT,
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  -- Headers and environment are encrypted as a whole: they are where
  -- credentials go when nobody used a {{secret:NAME}} reference.
  headers TEXT NOT NULL,
  env TEXT NOT NULL,
  -- What the server can do that an admin must acknowledge before an agent
  -- gets its tools: 'shell', 'filesystem', 'network'.
  capabilities TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- What the last successful discovery found, and which of it is switched off.
  tools TEXT NOT NULL DEFAULT '[]',
  disabled_tools TEXT NOT NULL DEFAULT '[]',
  last_tested_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((transport = 'http') = (url IS NOT NULL)),
  CHECK ((transport = 'stdio') = (command IS NOT NULL))
);

CREATE TABLE agent_mcp_tools (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  -- The capabilities acknowledged when this tool was given to the agent.
  granted_capabilities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, server_id, tool_name)
);
