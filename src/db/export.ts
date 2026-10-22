import fs from 'node:fs';
import { openSqlite, type Database } from './driver.js';
import { runMigrations } from './migrate.js';
import { registerDatabaseSecretKey } from './secrets.js';
import { verifyManagedDatabaseKey } from './managed-key.js';

/** Read a consistent source snapshot into a new, portable SQLite file. */
export function exportDatabase(source: Database, filename: string, key: Buffer): Record<string, number> {
  const fd = fs.openSync(filename, 'wx', 0o600);
  fs.closeSync(fd);
  let target: Database | undefined;
  try {
    target = openSqlite(filename);
    registerDatabaseSecretKey(target, key);
    runMigrations(target);
    const tables = (target.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'crewly_storage_metadata') ORDER BY name").pluck().all() as string[]);
    const sourceTables = new Set(source.prepare(source.dialect === 'postgres'
      ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = \'BASE TABLE\''
      : "SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]);
    if (tables.some((name) => !sourceTables.has(name))) throw new Error('Source schema is older than this server. Upgrade the source before exporting.');
    const unknown = [...sourceTables].filter((name) => !tables.includes(name) && !name.startsWith('sqlite_') && !['schema_migrations', 'crewly_storage_metadata'].includes(name));
    if (unknown.length) throw new Error('Source contains unrecognized tables; refusing an incomplete export.');
    const counts: Record<string, number> = {};
    target.pragma('foreign_keys = OFF');
    const destination = target;
    source.transaction(() => {
      if (source.dialect === 'postgres') source.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      destination.transaction(() => {
        for (const name of tables) {
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('Invalid table name');
          destination.exec(`DELETE FROM "${name}"`);
          const columns = destination.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; pk: number }[];
          const names = columns.map((column) => column.name);
          const quoted = names.map((column) => `"${column.replaceAll('"', '""')}"`).join(', ');
          const insert = destination.prepare(`INSERT INTO "${name}" (${quoted}) VALUES (${names.map(() => '?').join(', ')})`);
          const primary = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
          const order = (primary.length ? primary : columns).map((column) => `"${column.name.replaceAll('"', '""')}"`).join(', ');
          let offset = 0;
          while (true) {
            const rows = source.prepare(`SELECT ${quoted} FROM "${name}" ORDER BY ${order} LIMIT 500 OFFSET ?`).all(offset) as Record<string, unknown>[];
            for (const row of rows) insert.run(...names.map((column) => row[column]));
            offset += rows.length;
            if (rows.length < 500) break;
          }
          counts[name] = offset;
        }
        if ((destination.pragma('foreign_key_check') as unknown[]).length) throw new Error('Export contains broken foreign keys');
      })();
    })();
    // The imported primary can reject a wrong key before decrypting any API credentials.
    verifyManagedDatabaseKey(target, key);
    target.pragma('journal_mode = WAL');
    target.close(); target = undefined;
    return counts;
  } catch (error) {
    target?.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${filename}${suffix}`, { force: true });
    throw error;
  }
}
