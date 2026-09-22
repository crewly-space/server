-- An account that arrives from Crewly Cloud, rather than being created here.
--
-- The subject is Cloud's own user id, which never changes even when the
-- person changes their email, so the link survives a rename on either side.
CREATE TABLE external_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX external_identities_user_idx ON external_identities (user_id);

-- Every handoff token is single use. The row is kept until the token would
-- have expired anyway, which is all the replay window there is.
CREATE TABLE handoff_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE INDEX handoff_nonces_expiry_idx ON handoff_nonces (expires_at);

-- An account that only ever signs in through Cloud has no password, so the
-- column has to allow one to be absent. SQLite cannot drop a NOT NULL in
-- place, so the table is rebuilt. Nothing else about it changes.
CREATE TABLE users_rebuilt (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);

INSERT INTO users_rebuilt (id, email, display_name, password_hash, role, created_at)
  SELECT id, email, display_name, password_hash, role, created_at FROM users;

DROP TABLE users;

ALTER TABLE users_rebuilt RENAME TO users;
