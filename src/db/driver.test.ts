import { describe, expect, it } from 'vitest';
import { openSqlite } from './driver.js';

/**
 * The shipped `opencrew-server` binary and the Node process run the same
 * `node:sqlite` driver, so these cover the helpers this module adds on top of
 * it — and the binding semantics the repositories depend on.
 */
describe('sqlite driver', () => {
  function db() {
    const database = openSqlite(':memory:');
    database.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, n INTEGER)');
    return database;
  }

  it('binds @named parameters from bare-keyed objects', () => {
    const database = db();
    database
      .prepare('INSERT INTO users (id, email, n) VALUES (@id, @email, @n)')
      .run({ id: 'u1', email: 'a@b.c', n: 1 });
    expect(database.prepare('SELECT email FROM users WHERE id = ?').get('u1')).toEqual({
      email: 'a@b.c',
    });
  });

  it('returns undefined for a missing row', () => {
    // Repositories test with `!== undefined`, which a `null` would silently pass.
    expect(db().prepare('SELECT * FROM users WHERE id = ?').get('nope')).toBeUndefined();
  });

  it('rejects a boolean rather than coercing it', () => {
    expect(() =>
      db().prepare('INSERT INTO users (id, email, n) VALUES (?, ?, ?)').run('u1', 'a@b.c', true)
    ).toThrow();
  });

  it('reports changes and lastInsertRowid', () => {
    const result = db()
      .prepare('INSERT INTO users (id, email, n) VALUES (?, ?, ?)')
      .run('u1', 'a@b.c', 1);
    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
  });

  it('commits a transaction and rolls one back', () => {
    const database = db();
    const insert = database.prepare('INSERT INTO users (id, email, n) VALUES (?, ?, ?)');
    const count = () =>
      (database.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;

    database.transaction(() => {
      insert.run('u1', 'a@b.c', 1);
      insert.run('u2', 'd@e.f', 2);
    })();
    expect(count()).toBe(2);

    expect(() =>
      database.transaction(() => {
        insert.run('u3', 'g@h.i', 3);
        throw new Error('rollback please');
      })()
    ).toThrow('rollback please');
    expect(count()).toBe(2);
  });

  it('joins a nested transaction to the open one instead of committing early', () => {
    const database = db();
    const insert = database.prepare('INSERT INTO users (id, email, n) VALUES (?, ?, ?)');
    const inner = database.transaction(() => insert.run('inner', 'i@j.k', 1));

    expect(() =>
      database.transaction(() => {
        insert.run('outer', 'o@p.q', 1);
        inner();
        throw new Error('abort');
      })()
    ).toThrow('abort');

    expect((database.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c).toBe(0);
  });

  it('plucks the first column', () => {
    const database = db();
    database.prepare('INSERT INTO users (id, email, n) VALUES (?, ?, ?)').run('u1', 'a@b.c', 1);
    database.prepare('INSERT INTO users (id, email, n) VALUES (?, ?, ?)').run('u2', 'd@e.f', 2);
    expect(database.prepare('SELECT email FROM users ORDER BY id').pluck().get()).toBe('a@b.c');
    expect(database.prepare('SELECT email FROM users ORDER BY id').pluck().all()).toEqual([
      'a@b.c',
      'd@e.f',
    ]);
    expect(database.prepare('SELECT email FROM users WHERE id = ?').pluck().get('no')).toBeUndefined();
  });

  it('sets and reads a pragma, simply or as rows', () => {
    const database = openSqlite(':memory:');
    database.pragma('foreign_keys = ON');
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });
});
