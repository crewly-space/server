-- Agent-generated artifacts reuse attachment bytes and authorization, while
-- this relation records the run and agent that deliberately produced them.
CREATE TABLE artifacts (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX artifacts_run_idx ON artifacts(run_id, created_at);
CREATE INDEX artifacts_conversation_idx ON artifacts(conversation_id, created_at);
