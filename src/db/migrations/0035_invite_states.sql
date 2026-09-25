-- Invites become the normal way in, so an admin needs to see where each one
-- stands: pending, accepted, revoked or expired.
--
-- `email` is who the invite is for, when the admin said. It is what stops the
-- same person being invited twice, and what an accepting account must match.
-- `revoked_at` keeps a withdrawn invite on the list as revoked instead of
-- deleting it, so the list tells the truth about what was sent.
ALTER TABLE invites ADD COLUMN email TEXT;
ALTER TABLE invites ADD COLUMN revoked_at TEXT;

CREATE INDEX invites_email_idx ON invites (email);
