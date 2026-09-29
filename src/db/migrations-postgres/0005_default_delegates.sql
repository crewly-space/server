-- Counterpart of SQLite 0048: agents of one owner can delegate to each other by default. The statement is portable.
INSERT INTO agent_delegates (agent_id, delegate_agent_id, created_at)
SELECT a.id, b.id, a.created_at
FROM agents a
JOIN agents b ON b.owner_user_id = a.owner_user_id AND b.id <> a.id
WHERE NOT EXISTS (SELECT 1 FROM agent_delegates d WHERE d.agent_id = a.id)
ON CONFLICT DO NOTHING;
