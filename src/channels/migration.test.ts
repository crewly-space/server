import { it, expect } from 'vitest';
import { openSqlite } from '../db/driver.js';
import { EMBEDDED_MIGRATIONS } from '../db/migrations.generated.js';
import { runMigrations } from '../db/migrate.js';
it('widens conversations for channels without losing what points at them', () => {
  const db = openSqlite(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of EMBEDDED_MIGRATIONS.filter((m) => m.name < '0034')) { db.exec(m.sql); db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.name, 'x'); }
  const t = new Date().toISOString();
  db.prepare("INSERT INTO conversations VALUES ('c1','group','g',?,?)").run(t, t);
  db.prepare("INSERT INTO conversation_participants VALUES ('c1','u1','user',?)").run(t);
  db.prepare("INSERT INTO messages (id, conversation_id, author_id, author_type, body, created_at) VALUES ('m1','c1','u1','user','hi',?)").run(t);
  expect(runMigrations(db)).toContain('0034_channels.sql');
  expect(db.prepare('SELECT kind, name FROM conversations').all()).toEqual([{ kind: 'group', name: 'g' }]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(() => db.prepare("INSERT INTO messages (id, conversation_id, author_id, author_type, body, created_at) VALUES ('m2','nope','u1','user','hi',?)").run(t)).toThrow();
});
