-- Counterpart of SQLite 0045: allow the crewly-gateway provider kind.
ALTER TABLE provider_configs DROP CONSTRAINT IF EXISTS provider_configs_kind_check;
ALTER TABLE provider_configs ADD CONSTRAINT provider_configs_kind_check
  CHECK (kind IN ('anthropic', 'openai', 'openrouter', 'deepseek', 'openai-compatible', 'claude-subscription', 'ollama', 'crewly-gateway'));
