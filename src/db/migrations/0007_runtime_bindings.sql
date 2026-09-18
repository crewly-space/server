CREATE TABLE runtime_bindings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('native', 'claude-code', 'codex', 'gemini-cli')),
  workspace_path TEXT NOT NULL,
  vendor_state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_runtime_bindings_agent ON runtime_bindings (agent_id);
