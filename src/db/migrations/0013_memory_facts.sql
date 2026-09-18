CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  content_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('conversation', 'manual', 'summary')),
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_memory_facts_agent_content_key ON memory_facts (agent_id, content_key);
CREATE INDEX idx_memory_facts_agent_created ON memory_facts (agent_id, created_at);
