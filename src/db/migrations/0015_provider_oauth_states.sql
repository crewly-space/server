-- Pending provider-connect authorizations.
--
-- The browser leaves for the provider and comes back to the app, which then
-- redeems the code with its session token. The verifier never leaves the
-- server, and a state is single-use: redeeming it deletes the row.
CREATE TABLE provider_oauth_states (
  state TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX provider_oauth_states_expiry_idx ON provider_oauth_states(expires_at);
