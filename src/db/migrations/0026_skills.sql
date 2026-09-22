-- Skills: reusable instructions and configuration an agent can be given.
-- Distinct from MCP tools (things an agent can call) and coding runtimes
-- (where an agent works): a skill shapes how an agent works.
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  -- The settings an assignment fills in: [{key, label, secret, required}].
  config_fields TEXT NOT NULL DEFAULT '[]',
  -- Where it came from: written here ('custom') or installed from a manifest
  -- ('installed'), with the origin kept for a future registry to update from.
  source TEXT NOT NULL CHECK (source IN ('custom', 'installed')),
  source_ref TEXT,
  version TEXT NOT NULL DEFAULT '1',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_skills (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  -- Values for the skill's fields. A secret field holds a {{secret:NAME}}
  -- reference, never a value.
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill_id)
);
