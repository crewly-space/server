-- Crewly Gateway is a provider kind the API accepts, but the table's CHECK
-- predates it, so adding the Gateway failed with a constraint error. SQLite
-- cannot change a CHECK in place; rebuild the table with the kind allowed.
CREATE TABLE provider_configs_rebuilt (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'openrouter', 'deepseek', 'openai-compatible', 'claude-subscription', 'ollama', 'crewly-gateway')),
  api_key TEXT,
  base_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO provider_configs_rebuilt (id, kind, api_key, base_url, created_at, updated_at)
  SELECT id, kind, api_key, base_url, created_at, updated_at FROM provider_configs;

DROP TABLE provider_configs;
ALTER TABLE provider_configs_rebuilt RENAME TO provider_configs;
