-- How a person or an agent is drawn, chosen by them (or the agent's owner)
-- and shown the same to everyone. The avatar is generated on each device from
-- the id or name, so only the choice of style is stored -- no image, and
-- nothing that identifies anyone to an avatar service.
--   bloop    Crewly's own avatar, the default
--   blobatar the blob generator
--   name     initials from the name
ALTER TABLE users ADD COLUMN avatar_mode TEXT NOT NULL DEFAULT 'bloop'
  CHECK (avatar_mode IN ('bloop', 'blobatar', 'name'));
ALTER TABLE agents ADD COLUMN avatar_mode TEXT NOT NULL DEFAULT 'bloop'
  CHECK (avatar_mode IN ('bloop', 'blobatar', 'name'));
