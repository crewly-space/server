CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  participant_id TEXT NOT NULL,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('user', 'agent')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, participant_id, participant_type)
);

CREATE INDEX idx_conversation_participants_participant
  ON conversation_participants (participant_id, participant_type);
