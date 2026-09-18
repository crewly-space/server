CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_approvals_status ON approvals (status);
