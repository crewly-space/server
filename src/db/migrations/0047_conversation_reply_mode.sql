-- Who answers a message that addresses nobody: keyword/mention cues, a model
-- that picks, or every agent deciding for itself.
ALTER TABLE conversations ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'mentions'
  CHECK (reply_mode IN ('mentions', 'model', 'open'));
