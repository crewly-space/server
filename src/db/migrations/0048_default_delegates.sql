-- Agents of one owner can hand each other subtasks by default. Until now the
-- delegate list started empty, so no agent was ever offered delegate_to_agent
-- and told the user it could not talk to other agents. This backfills the
-- pairs that already exist; an agent that already has a list is left alone,
-- so a list someone curated (or emptied on purpose) is not overwritten.
INSERT INTO agent_delegates (agent_id, delegate_agent_id, created_at)
SELECT a.id, b.id, a.created_at
FROM agents a
JOIN agents b ON b.owner_user_id = a.owner_user_id AND b.id <> a.id
WHERE NOT EXISTS (SELECT 1 FROM agent_delegates d WHERE d.agent_id = a.id)
ON CONFLICT DO NOTHING;
