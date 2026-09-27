import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { isUniqueViolation, openSqlite, type Database } from './driver.js';
import { runMigrations } from './migrate.js';
import { openPostgres, translateForPostgres } from './postgres.js';

describe('SQLite to PostgreSQL translation', () => {
  it('numbers positional placeholders and reuses one number per name', () => {
    expect(translateForPostgres('SELECT * FROM t WHERE a = ? AND b = ?').text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    const named = translateForPostgres('UPDATE t SET a = @a, b = @b WHERE a <> @a');
    expect(named.text).toBe('UPDATE t SET a = $1, b = $2 WHERE a <> $1');
    expect(named.names).toEqual(['a', 'b']);
  });

  it('leaves quoted text and comments alone', () => {
    expect(translateForPostgres("SELECT '?', \"@x\" -- is it ?\nFROM t WHERE a = ?").text)
      .toBe("SELECT '?', \"@x\" -- is it ?\nFROM t WHERE a = $1");
  });

  it('turns INSERT OR IGNORE into ON CONFLICT DO NOTHING, before any RETURNING', () => {
    expect(translateForPostgres('INSERT OR IGNORE INTO t (a) VALUES (?)').text).toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING');
    expect(translateForPostgres('INSERT OR IGNORE INTO t (a) VALUES (?) RETURNING a').text)
      .toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING RETURNING a');
  });

  it('keeps null-safe IS and case-insensitive NOCASE meaning what they meant', () => {
    expect(translateForPostgres('SELECT 1 FROM t WHERE c IS ? AND d IS NOT ?').text)
      .toBe('SELECT 1 FROM t WHERE c IS NOT DISTINCT FROM $1 AND d IS DISTINCT FROM $2');
    expect(translateForPostgres('SELECT 1 FROM t WHERE c IS NULL').text).toBe('SELECT 1 FROM t WHERE c IS NULL');
    expect(translateForPostgres('SELECT * FROM users WHERE email = ? COLLATE NOCASE').text)
      .toBe('SELECT * FROM users WHERE lower(email) = lower($1)');
    expect(translateForPostgres('SELECT * FROM t ORDER BY position, c.name COLLATE NOCASE').text)
      .toBe('SELECT * FROM t ORDER BY position, lower(c.name)');
  });

  it('remembers camelCase aliases so rows keep their spelling', () => {
    expect([...translateForPostgres('SELECT a AS createdAt, b AS plain FROM t').aliases!]).toEqual([['createdat', 'createdAt']]);
  });
});

const server = process.env.CREWLY_TEST_DATABASE_URL?.trim();

function freshUrl(): string {
  const url = new URL(server!);
  url.searchParams.set('options', `-c search_path=driver_test_${randomUUID().replaceAll('-', '')}`);
  return url.toString();
}

describe.skipIf(!server)('PostgreSQL driver', () => {
  const open: Database[] = [];
  const connect = (): Database => {
    const db = openPostgres(freshUrl());
    open.push(db);
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, n BIGINT, rowid BIGINT GENERATED ALWAYS AS IDENTITY)');
    return db;
  };
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });

  it('keeps a transaction usable after a statement in it fails, as SQLite does', () => {
    const db = connect();
    db.prepare('INSERT INTO t (id) VALUES (?)').run('a');
    db.transaction(() => {
      let refused: unknown;
      try {
        db.prepare('INSERT INTO t (id) VALUES (?)').run('a');
      } catch (error) {
        refused = error;
      }
      expect(isUniqueViolation(refused)).toBe(true);
      db.prepare('INSERT INTO t (id) VALUES (?)').run('b');
    })();
    expect(db.prepare('SELECT id FROM t ORDER BY rowid').pluck().all()).toEqual(['a', 'b']);
  });

  it('rolls the whole transaction back when it throws, nested calls included', () => {
    const db = connect();
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO t (id) VALUES (?)').run('x');
      db.transaction(() => db.prepare('INSERT INTO t (id) VALUES (?)').run('y'))();
      throw new Error('stop');
    })()).toThrow('stop');
    expect(db.prepare('SELECT COUNT(*) FROM t').pluck().get()).toBe(0);
  });

  it('answers like SQLite: counts as numbers, rowid hidden, aliases intact, NULL-safe IS', () => {
    const db = connect();
    db.prepare('INSERT INTO t (id, name, n) VALUES (?, ?, ?)').run('a', 'Alpha', 2 ** 40);
    db.prepare('INSERT OR IGNORE INTO t (id, name) VALUES (?, ?)').run('a', 'ignored');
    expect(db.prepare('SELECT * FROM t').all()).toEqual([{ id: 'a', name: 'Alpha', n: 2 ** 40 }]);
    expect(db.prepare('SELECT COUNT(*) AS rowCount FROM t').get()).toEqual({ rowCount: 1 });
    expect(db.prepare('SELECT id FROM t WHERE name = ? COLLATE NOCASE').pluck().get('ALPHA')).toBe('a');
    expect(db.prepare('SELECT id FROM t WHERE n IS ?').pluck().get(null)).toBeUndefined();
    expect(db.prepare('UPDATE t SET name = @name WHERE id = @id').run({ id: 'a', name: 'B' }).changes).toBe(1);
  });

  it('refuses booleans rather than guessing, as node:sqlite does', () => {
    const db = connect();
    expect(() => db.prepare('SELECT ?').get(true)).toThrow(/boolean/);
  });

  it('reconnects when the connection is lost between statements', () => {
    const db = connect();
    const pid = db.prepare('SELECT pg_backend_pid()').pluck().get();
    const killer = openPostgres(server!);
    open.push(killer);
    killer.prepare('SELECT pg_terminate_backend(?::int)').get(pid);
    // The statement that finds the connection gone fails; the next one reconnects.
    try {
      db.prepare('SELECT 1').get();
    } catch {
      // expected once
    }
    expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
  });
});

/*
 * A PostgreSQL server starts from a baseline rather than SQLite's history, so
 * nothing but this test notices a SQLite migration that was never given a
 * PostgreSQL counterpart: both must describe the same tables, columns and
 * seeded rows.
 */
describe.skipIf(!server)('schema parity with SQLite', () => {
  it('has the same tables, columns and seeded rows after migrating', () => {
    // An empty name is SQLite's private temporary database. ':memory:' would
    // do, except that the PostgreSQL test run swaps it for PostgreSQL.
    const sqlite = openSqlite('');
    const postgres = openPostgres(freshUrl());
    try {
      runMigrations(sqlite);
      runMigrations(postgres);

      const sqliteTables = (sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'schema_migrations') ORDER BY name",
      ).pluck().all() as string[]);
      const postgresTables = (postgres.prepare(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'schema_migrations' ORDER BY table_name",
      ).pluck().all() as string[]);
      expect(postgresTables).toEqual(sqliteTables);

      for (const table of sqliteTables) {
        const sqliteColumns = (sqlite.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY name`).pluck().all() as string[]);
        const postgresColumns = (postgres.prepare(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name <> 'rowid' ORDER BY column_name",
        ).pluck().all(table) as string[]);
        expect(postgresColumns, table).toEqual(sqliteColumns);

        // When a seed ran is not part of what it seeds.
        const order = sqliteColumns.map((column) => `"${column}"`).join(', ');
        const rows = (db: Database) => (db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all() as Record<string, unknown>[])
          .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key.endsWith('_at') && value ? 'timestamp' : value])));
        expect(rows(postgres), table).toEqual(rows(sqlite));
      }
    } finally {
      sqlite.close();
      postgres.close();
    }
  });
});
