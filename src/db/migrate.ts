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

  const newlyApplied: string[] = [];
  for (const { name, sql } of EMBEDDED_MIGRATIONS) {
    if (applied.has(name)) continue;
    const applyOne = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        name,
        new Date().toISOString()
      );
    });
    applyOne();
    newlyApplied.push(name);
  }
  encryptLegacyProviderSecrets(db);
  return newlyApplied;
}
