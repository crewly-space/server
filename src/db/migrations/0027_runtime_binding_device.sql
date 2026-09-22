-- A coding runtime runs on a paired device, in one of that device's
-- workspaces. The binding now says which device, and carries the few
-- runtime options a person may set -- never the vendor's session state,
-- which stays the runtime's own.
ALTER TABLE runtime_bindings ADD COLUMN device_id TEXT REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE runtime_bindings ADD COLUMN workspace_id TEXT;
ALTER TABLE runtime_bindings ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
