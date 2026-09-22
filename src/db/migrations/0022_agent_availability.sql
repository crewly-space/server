-- An agent's own say in whether it is available. 'auto' leaves presence to
-- what the agent is actually doing; 'dnd' keeps it out of anything automatic
-- (routing, delegation) while still answering when it is addressed directly.
ALTER TABLE agents ADD COLUMN availability TEXT NOT NULL DEFAULT 'auto'
  CHECK (availability IN ('auto', 'dnd'));
