-- Channels: persistent, named rooms that belong to the server rather than to
-- whoever started them. A channel is a conversation of its own kind, so its
-- history, mentions, agent runs and realtime events are the ones every other
-- conversation already has; DMs and groups are untouched.
--
--   visibility    public channels can be found, read and joined by anyone on
--                 the server; private ones only by their members
--   post_role     the least server role a member needs to post, so a channel
--                 can be read by everyone and written by admins
--   category_id   the sidebar section it sits in, NULL for none
--   position      its order within that section
--   archived_at   set once it is archived: kept and readable, no longer posted to
--
-- Threads and pinned messages hang off messages, not channels, so neither
-- needs anything here.
CREATE TABLE channel_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- SQLite cannot widen a CHECK in place, so the table is rebuilt. Existing rows
-- keep their ids, and everything that points at them keeps pointing.
CREATE TABLE conversations_rebuilt (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'channel')),
  name TEXT,
  topic TEXT,
  visibility TEXT CHECK (visibility IN ('public', 'private')),
  post_role TEXT CHECK (post_role IN ('member', 'admin', 'owner')),
  category_id TEXT REFERENCES channel_categories(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind <> 'channel' OR (name IS NOT NULL AND visibility IS NOT NULL AND post_role IS NOT NULL))
);

INSERT INTO conversations_rebuilt (id, kind, name, created_at, updated_at)
  SELECT id, kind, name, created_at, updated_at FROM conversations;

DROP TABLE conversations;

ALTER TABLE conversations_rebuilt RENAME TO conversations;

CREATE INDEX idx_conversations_channels ON conversations (kind, category_id, position);

-- Agents an admin has kept out of a channel. A blocked agent cannot be added
-- to it, and blocking one that is already in it takes it out.
CREATE TABLE channel_agent_blocks (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  blocked_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
);
