-- Which agents an agent may hand a subtask to. An explicit list per agent:
-- delegation spends another agent's budget and uses its tools, so it is
-- granted, not assumed.
CREATE TABLE agent_delegates (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  delegate_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, delegate_agent_id),
  CHECK (agent_id <> delegate_agent_id)
);
