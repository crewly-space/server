-- Human/server RBAC is separate from agent capability policy. Built-in roles
-- keep the compatibility role column; custom roles add explicit permissions.
CREATE TABLE server_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_server_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_server_roles_role_idx ON user_server_roles(role_id, created_at);

INSERT INTO server_roles (id, name, description, permissions, built_in, created_at, updated_at) VALUES
  ('builtin-owner', 'Owner', 'Full server authority and recovery control.', '["members.view","members.manage","members.invite","agents.create","agents.manage","providers.manage","integrations.manage","automations.manage","server.settings","operations.view","roles.manage"]', 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('builtin-admin', 'Admin', 'Day-to-day server administration without ownership transfer.', '["members.view","members.manage","members.invite","agents.create","agents.manage","providers.manage","integrations.manage","automations.manage","server.settings","operations.view","roles.manage"]', 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('builtin-member', 'Member', 'Normal workspace participation.', '["agents.create"]', 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
