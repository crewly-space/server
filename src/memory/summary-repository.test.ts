import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createMessage } from '../messages/repository.js';
import { getConversationSummary, upsertConversationSummary } from './summary-repository.js';

describe('conversation summary repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithMessage() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-summary-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    const alice = createUser(db, { email: 'alice@example.com', displayName: 'Alice', passwordHash: 'x', role: 'owner' });
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'y', role: 'member' });
    const conversation = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: alice.id, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });
    const message = createMessage(db, {
      conversationId: conversation.id,
      authorId: alice.id,
      authorType: 'user',
      body: 'hello',
      mentions: [],
      replyToMessageId: null,
    });
    return { db, conversation, message };
  }

  it('returns undefined when no summary exists yet', () => {
    const { db, conversation } = freshDbWithMessage();
    expect(getConversationSummary(db, conversation.id)).toBeUndefined();
    db.close();
  });

  it('creates then updates a summary for the same conversation', () => {
    const { db, conversation, message } = freshDbWithMessage();
    const created = upsertConversationSummary(db, { conversationId: conversation.id, summary: 'first pass', upToMessageId: message.id });
    expect(created.summary).toBe('first pass');

    const updated = upsertConversationSummary(db, { conversationId: conversation.id, summary: 'second pass', upToMessageId: message.id });
    expect(updated.summary).toBe('second pass');
    expect(getConversationSummary(db, conversation.id)?.summary).toBe('second pass');
    db.close();
  });
});
