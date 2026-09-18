CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY,
  root_run_id TEXT NOT NULL,
  causation_id TEXT,
  hop_count INTEGER NOT NULL CHECK (hop_count >= 0 AND hop_count <= 4),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_agent_runs_root ON agent_runs (root_run_id);
