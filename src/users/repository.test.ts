import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { countUsers, createUser, getUserByEmail, getUserById } from './repository.js';

describe('users repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDb() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-users-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    return db;
  }

  it('creates a user and reads it back by id and email', () => {
    const db = freshDb();
    const created = createUser(db, {
      email: 'owner@example.com',
      displayName: 'Owner',
      passwordHash: 'salt:hash',
      role: 'owner',
    });
    expect(getUserById(db, created.id)?.email).toBe('owner@example.com');
    expect(getUserByEmail(db, 'owner@example.com')?.id).toBe(created.id);
    db.close();
  });

  it('counts zero users on a fresh database and increments after creation', () => {
    const db = freshDb();
    expect(countUsers(db)).toBe(0);
    createUser(db, { email: 'a@example.com', displayName: 'A', passwordHash: 'x', role: 'member' });
    expect(countUsers(db)).toBe(1);
    db.close();
  });

  it('rejects a duplicate email', () => {
    const db = freshDb();
    createUser(db, { email: 'dup@example.com', displayName: 'A', passwordHash: 'x', role: 'member' });
    expect(() =>
      createUser(db, { email: 'dup@example.com', displayName: 'B', passwordHash: 'y', role: 'member' })
    ).toThrow();
    db.close();
  });
});
