CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  personality TEXT NOT NULL DEFAULT '',
  model_policy TEXT NOT NULL,
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agents_owner ON agents (owner_user_id);
