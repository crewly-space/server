CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('webhook', 'message', 'schedule', 'run')),
  trigger_config TEXT NOT NULL DEFAULT '{}',
  conditions TEXT NOT NULL DEFAULT '{}',
  actions TEXT NOT NULL DEFAULT '[]',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX automations_enabled_trigger_idx ON automations(enabled, trigger_type);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger_event_id TEXT,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  hop_count INTEGER NOT NULL DEFAULT 0,
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (automation_id, dedupe_key)
);

CREATE INDEX automation_runs_created_idx ON automation_runs(automation_id, created_at);

UPDATE server_roles
SET permissions = json_insert(permissions, '$[#]', 'automations.manage'),
    updated_at = '1970-01-01T00:00:00.000Z'
WHERE id IN ('builtin-owner', 'builtin-admin')
  AND instr(permissions, 'automations.manage') = 0;
