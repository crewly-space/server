-- Providers whose access tokens expire (GitHub apps with expiring tokens,
-- Google, Dropbox, Linear, GitLab, Asana) hand out a refresh token with them.
-- It is encrypted like the access token. `oauth_app` says whose OAuth app
-- issued them -- this server's own, or Crewly's through the connector broker --
-- because only that app's secret can renew them.
ALTER TABLE connectors ADD COLUMN refresh_ciphertext TEXT;
ALTER TABLE connectors ADD COLUMN token_expires_at TEXT;
ALTER TABLE connectors ADD COLUMN oauth_app TEXT NOT NULL DEFAULT 'local';
