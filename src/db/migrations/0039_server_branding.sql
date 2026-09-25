-- Identity for the server currently being operated. It is deliberately one
-- row: this is server-scoped metadata, not a second registry entry.
CREATE TABLE server_branding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT 'Crewly',
  tagline TEXT NOT NULL DEFAULT '',
  icon_data_url TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO server_branding (id, updated_at)
  VALUES (1, CURRENT_TIMESTAMP);
