-- Where replies to this server's email come back: Crewly's inbound domain
-- and this server's key in it, learned once from Crewly.
ALTER TABLE crewly_connection ADD COLUMN inbound_domain TEXT;
ALTER TABLE crewly_connection ADD COLUMN inbound_key TEXT;

-- The token in a reply address (reply+<key>.<token>@…) names one person in
-- one conversation. A reply is accepted only from that person's address.
CREATE TABLE mail_reply_tokens (
  token TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX mail_reply_tokens_pair_idx ON mail_reply_tokens (conversation_id, user_id);

-- Addresses such as support@company.com that post into a channel. The admin
-- who set one up is who the messages are posted as.
CREATE TABLE mail_inbound_routes (
  address TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  posted_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- Every inbound message Crewly handed over, keyed by Crewly's id so a second
-- delivery of the same one is recognised. What was posted lives in messages.
CREATE TABLE mail_inbound (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'route')),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'rejected')),
  reason TEXT,
  conversation_id TEXT,
  message_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE INDEX mail_inbound_processed_idx ON mail_inbound (processed_at);
