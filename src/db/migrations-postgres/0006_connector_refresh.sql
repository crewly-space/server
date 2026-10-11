-- Counterpart of SQLite 0049: refresh tokens and expiry for connectors. The statements are portable.
ALTER TABLE connectors ADD COLUMN refresh_ciphertext TEXT;
ALTER TABLE connectors ADD COLUMN token_expires_at TEXT;
ALTER TABLE connectors ADD COLUMN oauth_app TEXT NOT NULL DEFAULT 'local';
