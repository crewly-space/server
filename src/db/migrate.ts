import type { Database } from './driver.js';
import { EMBEDDED_MIGRATIONS } from './migrations.generated.js';
import { encryptLegacyProviderSecrets } from './secrets.js';

export function runMigrations(db: Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[];
  const applied = new Set(appliedRows.map((r) => r.name));

  // A migration that rebuilds a table (SQLite cannot alter a column in place)
  // drops the old one, and with foreign keys on that drop is a DELETE: it is
  // refused when anything still points at a row, and it cascades into every
  // ON DELETE CASCADE child when nothing stops it. SQLite's own procedure is to
  // switch enforcement off around the rebuild and check the result afterwards.
  // The pragma is ignored inside a transaction, so it is set out here.
  const enforced = db.pragma('foreign_keys', { simple: true }) === 1;
  if (enforced) db.pragma('foreign_keys = OFF');
  // Only what a migration breaks is its fault; an old database may already
  // carry a dangling row, and that must not stop every upgrade after it.
  const brokenBefore = (db.pragma('foreign_key_check') as unknown[]).length;

  const newlyApplied: string[] = [];
  try {
    for (const { name, sql } of EMBEDDED_MIGRATIONS) {
      if (applied.has(name)) continue;
      const applyOne = db.transaction(() => {
        db.exec(sql);
        const broken = (db.pragma('foreign_key_check') as unknown[]).length;
        if (broken > brokenBefore) {
          throw new Error(`migration ${name} left ${broken - brokenBefore} broken foreign key reference(s)`);
        }
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
          name,
          new Date().toISOString()
        );
      });
      applyOne();
      newlyApplied.push(name);
    }
  } finally {
    if (enforced) db.pragma('foreign_keys = ON');
  }
  encryptLegacyProviderSecrets(db);
  return newlyApplied;
}
