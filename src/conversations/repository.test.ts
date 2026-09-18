import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import {
  addParticipant,
  createConversation,
  findDmConversation,
  getConversation,
  isParticipant,
  listConversationsForParticipant,
  removeParticipant,
} from './repository.js';

describe('conversations repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithTwoUsers() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-conversations-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    const alice = createUser(db, { email: 'alice@example.com', displayName: 'Alice', passwordHash: 'x', role: 'owner' });
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'y', role: 'member' });
    return { db, alice, bob };
  }

  it('creates a dm with exactly two participants and reads it back', () => {
    const { db, alice, bob } = freshDbWithTwoUsers();
    const dm = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: alice.id, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });
    expect(dm.kind).toBe('dm');
    expect(dm.participants).toHaveLength(2);
    expect(getConversation(db, dm.id)?.id).toBe(dm.id);
    db.close();
  });

  it('creates a named group conversation', () => {
    const { db, alice, bob } = freshDbWithTwoUsers();
    const group = createConversation(db, {
      kind: 'group',
      name: 'Launch planning',
      participants: [
        { participantId: alice.id, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });
    expect(group.name).toBe('Launch planning');
    db.close();
  });

  it('reports isParticipant correctly and lists conversations for a participant', () => {
    const { db, alice, bob } = freshDbWithTwoUsers();
    const dm = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: alice.id, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });
    expect(isParticipant(db, dm.id, alice.id, 'user')).toBe(true);
    expect(isParticipant(db, dm.id, 'nonexistent-user', 'user')).toBe(false);

    const aliceConversations = listConversationsForParticipant(db, alice.id);
    expect(aliceConversations).toHaveLength(1);
    expect(aliceConversations[0].id).toBe(dm.id);
    db.close();
  });

  it('finds an existing dm conversation for a participant pair', () => {
    const { db, alice, bob } = freshDbWithTwoUsers();
    const dm = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: alice.id, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });
    const found = findDmConversation(db, alice.id, bob.id);
    expect(found?.id).toBe(dm.id);
    const foundReversed = findDmConversation(db, bob.id, alice.id);
    expect(foundReversed?.id).toBe(dm.id);
    db.close();
  });

  it('returns undefined from findDmConversation when no dm exists for the pair', () => {
    const { db, alice, bob } = freshDbWithTwoUsers();
    expect(findDmConversation(db, alice.id, bob.id)).toBeUndefined();
    db.close();
  });

  it('adds and removes a participant from a group', () => {
    const { db, alice, bob } = freshDbWithTwoUsers();
    const carol = createUser(db, { email: 'carol@example.com', displayName: 'Carol', passwordHash: 'z', role: 'member' });
    const group = createConversation(db, {
      kind: 'group',
      name: 'Team',
      participants: [
        { participantId: alice.id, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });
    addParticipant(db, group.id, { participantId: carol.id, participantType: 'user' });
    expect(isParticipant(db, group.id, carol.id, 'user')).toBe(true);

    removeParticipant(db, group.id, carol.id);
    expect(isParticipant(db, group.id, carol.id, 'user')).toBe(false);
    db.close();
  });
});
