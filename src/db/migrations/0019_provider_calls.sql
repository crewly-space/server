-- Every call the AI gateway made to a model provider, one row per attempt.
--
-- This is the meter: usage, cost, provider health and the run inspector all
-- read it. Nothing here references agents, runs or conversations by foreign
-- key on purpose -- deleting an agent must not rewrite what was already spent.
-- No prompt or completion text is stored, only its size and its outcome.
CREATE TABLE provider_calls (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  -- What the call was for: 'agent_turn' today, room for 'routing', 'summary'.
  purpose TEXT NOT NULL,
  agent_id TEXT,
  run_id TEXT,
  root_run_id TEXT,
  conversation_id TEXT,
  -- 1 for the first try; retries count up from there.
  attempt INTEGER NOT NULL,
  -- 1 when this call went to the agent's fallback provider/model.
  fallback INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_code TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Estimated cost in millionths of a US dollar; NULL when the model has no price.
  cost_micros INTEGER,
  latency_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX provider_calls_created_idx ON provider_calls (created_at);
CREATE INDEX provider_calls_provider_idx ON provider_calls (provider_id, created_at);
CREATE INDEX provider_calls_agent_idx ON provider_calls (agent_id, created_at);
CREATE INDEX provider_calls_run_idx ON provider_calls (run_id);
CREATE INDEX provider_calls_root_idx ON provider_calls (root_run_id);
