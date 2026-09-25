-- How an agent decides whether a message in a shared conversation should wake it.
-- `mention_only` preserves the pre-routing behavior for existing agents.
ALTER TABLE agents ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'mention_only'
  CHECK (routing_mode IN ('always', 'mention_only', 'relevant', 'disabled'));

-- A channel can override an agent's default routing mode. Groups use the same
-- table when an override is explicitly created by a future client, but the UI
-- currently exposes channel overrides only.
CREATE TABLE agent_conversation_routing (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('always', 'mention_only', 'relevant', 'disabled')),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, conversation_id)
);

CREATE INDEX idx_agent_conversation_routing_conversation
  ON agent_conversation_routing (conversation_id);
