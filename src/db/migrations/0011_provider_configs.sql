CREATE TABLE provider_configs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'openrouter', 'deepseek', 'openai-compatible', 'claude-subscription', 'ollama')),
  api_key TEXT,
  base_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
