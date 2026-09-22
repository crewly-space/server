-- A run is no longer only a row saying it happened: it has a lifecycle, a
-- cause and an outcome, so a failed or slow reply can be explained afterwards.
-- Runs recorded before this existed are marked completed; nothing was kept
-- that could say otherwise.
ALTER TABLE agent_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'));
-- What started it: a message, another agent delegating, an API call.
ALTER TABLE agent_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'message';
ALTER TABLE agent_runs ADD COLUMN trigger_message_id TEXT;
ALTER TABLE agent_runs ADD COLUMN result_message_id TEXT;
ALTER TABLE agent_runs ADD COLUMN started_at TEXT;
ALTER TABLE agent_runs ADD COLUMN finished_at TEXT;
ALTER TABLE agent_runs ADD COLUMN error_code TEXT;
ALTER TABLE agent_runs ADD COLUMN error_message TEXT;

CREATE INDEX agent_runs_status_idx ON agent_runs (status, created_at);
CREATE INDEX agent_runs_agent_idx ON agent_runs (agent_id, created_at);
CREATE INDEX agent_runs_result_message_idx ON agent_runs (result_message_id);

-- The trace: what happened during a run, in order. Metadata only -- which
-- provider, how long, how many tokens, which tool, whether it worked. Prompts,
-- completions and tool inputs or outputs are never written here, so a trace
-- can be shown to whoever may see the conversation without leaking what a
-- tool touched.
CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
