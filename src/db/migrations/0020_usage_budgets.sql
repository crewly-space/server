-- What a model costs, when an admin says so. Built-in list prices live in code;
-- a row here overrides them (a negotiated rate, a model the list does not know).
-- Prices are in millionths of a US dollar per million tokens.
CREATE TABLE model_prices (
  provider_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_mtok_micros INTEGER NOT NULL CHECK (input_per_mtok_micros >= 0),
  output_per_mtok_micros INTEGER NOT NULL CHECK (output_per_mtok_micros >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_kind, model)
);

-- A spending limit for the whole server or one agent, per UTC day or month.
CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('server', 'agent')),
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('daily', 'monthly')),
  limit_micros INTEGER NOT NULL CHECK (limit_micros > 0),
  -- What happens at the limit: tell people, stop the agent, or move it to
  -- its fallback model.
  action TEXT NOT NULL CHECK (action IN ('warn', 'block', 'fallback')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'server') = (agent_id IS NULL))
);

-- One budget per scope and period; the expression covers the NULL agent_id of
-- a server budget, which a plain UNIQUE would treat as always distinct.
CREATE UNIQUE INDEX budgets_scope_idx ON budgets (scope, COALESCE(agent_id, ''), period);

-- Each threshold alerts once per period, however many calls cross it.
CREATE TABLE budget_alerts (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  spent_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (budget_id, period_start, threshold)
);
