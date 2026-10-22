import { describe, expect, it } from 'vitest';
import { openSqlite } from './driver.js';
import { verifyManagedDatabaseKey } from './managed-key.js';

describe.skipIf(Boolean(process.env.CREWLY_TEST_DATABASE_URL))('libSQL compatibility', () => {
  it('binds a lone null, named values and binary data without leaking query metadata', () => {
    const db = openSqlite(':memory:');
    try {
      db.exec('CREATE TABLE example (id TEXT PRIMARY KEY, data BLOB, value TEXT)');
      db.prepare('INSERT INTO example VALUES (@id, @data, @value)').run({ id: 'one', data: Buffer.from('hello'), value: null });
      expect(db.prepare('SELECT value FROM example WHERE value IS ?').get(null)).toEqual({ value: null });
      expect(Buffer.from(db.prepare('SELECT data FROM example WHERE id = ?').pluck().get('one') as Uint8Array)).toEqual(Buffer.from('hello'));
      expect(db.prepare('SELECT id FROM example').get()).toEqual({ id: 'one' });
      expect(db.prepare('SELECT id FROM example WHERE id = ?').get('missing')).toBeUndefined();
      expect(db.prepare('SELECT id FROM example').all()).toEqual([{ id: 'one' }]);
    } finally { db.close(); }
  });
  it('joins nested transactions and rolls the whole operation back', () => {
    const db = openSqlite(':memory:');
    try {
      db.exec('CREATE TABLE example (id TEXT PRIMARY KEY)');
      const insert = db.transaction(() => db.prepare('INSERT INTO example VALUES (?)').run('inside'));
      expect(() => db.transaction(() => { insert(); throw new Error('abort'); })()).toThrow('abort');
      expect(db.prepare('SELECT COUNT(*) FROM example').pluck().get()).toBe(0);
    } finally { db.close(); }
  });
  it('pins the encryption key in the primary, including on a new deployment', () => {
    const db = openSqlite(':memory:');
    try {
      verifyManagedDatabaseKey(db, Buffer.alloc(32, 1));
      verifyManagedDatabaseKey(db, Buffer.alloc(32, 1));
      expect(() => verifyManagedDatabaseKey(db, Buffer.alloc(32, 2))).toThrow(/original key/);
    } finally { db.close(); }
  });
});
