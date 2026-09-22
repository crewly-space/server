-- An invitation to join this server.
--
-- The code is stored hashed, the way a session token is: a stolen database
-- should not hand somebody a working way in. It is shown once, when it is
-- made, and the list afterwards says who made it and whether it was used.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- A note for whoever reads the list later: "the new designer", "CI".
  label TEXT
);

CREATE INDEX invites_expiry_idx ON invites (expires_at);

-- Taking someone's access away without deleting them, and therefore without
-- deleting what they wrote. The row stays so it can be given back, and so
-- there is a record that it was taken away.
ALTER TABLE users ADD COLUMN suspended_at TEXT;
