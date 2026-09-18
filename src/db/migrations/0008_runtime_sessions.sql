CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  runtime_binding_id TEXT NOT NULL REFERENCES runtime_bindings(id),
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'waiting_approval', 'error', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_runtime_sessions_agent_conversation ON runtime_sessions (agent_id, conversation_id);
