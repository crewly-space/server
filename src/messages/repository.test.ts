import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createConversation, listConversationsForParticipant } from '../conversations/repository.js';
import { createMessage, listMessagesForConversation, listRecentMessagesForConversation, ReplyNotInConversationError } from './repository.js';

function waitForNextMillisecond(): void {
  const start = Date.now();
  while (Date.now() === start) {
    // busy-wait to guarantee a strictly later ISO timestamp for the next write
  }
}

describe('messages repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithConversation() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-messages-'));
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
    return { db, alice, bob, conversation };
  }

  it('creates a message with a mention and reads it back in order', () => {
    const { db, alice, bob, conversation } = freshDbWithConversation();
    const message = createMessage(db, {
      conversationId: conversation.id,
      authorId: alice.id,
      authorType: 'user',
      body: `hey @${bob.display_name} following up`,
      mentions: [{ targetId: bob.id, targetType: 'user' }],
      replyToMessageId: null,
    });
    expect(message.mentions).toHaveLength(1);

    const list = listMessagesForConversation(db, conversation.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(message.id);
    db.close();
  });

  it('accepts a reply to a message in the same conversation', () => {
    const { db, alice, conversation } = freshDbWithConversation();
    const first = createMessage(db, {
      conversationId: conversation.id,
      authorId: alice.id,
      authorType: 'user',
      body: 'first message',
      mentions: [],
      replyToMessageId: null,
    });
    const reply = createMessage(db, {
      conversationId: conversation.id,
      authorId: alice.id,
      authorType: 'user',
      body: 'a reply',
      mentions: [],
      replyToMessageId: first.id,
    });
    expect(reply.replyToMessageId).toBe(first.id);
    db.close();
  });

  it('rejects a reply that references a message from a different conversation', () => {
    const { db, alice, bob, conversation } = freshDbWithConversation();
    const otherConversation = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: alice.id, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });
    const messageInOther = createMessage(db, {
      conversationId: otherConversation.id,
      authorId: alice.id,
      authorType: 'user',
      body: 'lives elsewhere',
      mentions: [],
      replyToMessageId: null,
    });
    expect(() =>
      createMessage(db, {
        conversationId: conversation.id,
        authorId: alice.id,
        authorType: 'user',
        body: 'wrong reply target',
        mentions: [],
        replyToMessageId: messageInOther.id,
      })
    ).toThrow(ReplyNotInConversationError);
    db.close();
  });

  it('bumps the conversation updated_at when a message is posted, reordering the participant list', () => {
    const { db, alice, conversation: older } = freshDbWithConversation();
    const bob = createUser(db, { email: 'bob2@example.com', displayName: 'Bob2', passwordHash: 'y', role: 'member' });

    // Ensure the second conversation has a strictly later created_at/updated_at than `older`.
    waitForNextMillisecond();
    const newer = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: alice.id, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });

    // Without any activity, the newer conversation sorts first.
    const initialOrder = listConversationsForParticipant(db, alice.id);
    expect(initialOrder[0].id).toBe(newer.id);
    expect(initialOrder[1].id).toBe(older.id);

    // Posting a message to the older conversation should bump its updated_at past the
    // newer, message-free conversation.
    waitForNextMillisecond();
    createMessage(db, {
      conversationId: older.id,
      authorId: alice.id,
      authorType: 'user',
      body: 'bringing this one back to the top',
      mentions: [],
      replyToMessageId: null,
    });

    const reordered = listConversationsForParticipant(db, alice.id);
    expect(reordered[0].id).toBe(older.id);
    expect(reordered[1].id).toBe(newer.id);
    db.close();
  });

  it('returns the newest messages in chronological order when limited', () => {
    const { db, alice, conversation } = freshDbWithConversation();
    createMessage(db, { conversationId: conversation.id, authorId: alice.id, authorType: 'user', body: 'one', mentions: [], replyToMessageId: null });
    createMessage(db, { conversationId: conversation.id, authorId: alice.id, authorType: 'user', body: 'two', mentions: [], replyToMessageId: null });
    createMessage(db, { conversationId: conversation.id, authorId: alice.id, authorType: 'user', body: 'three', mentions: [], replyToMessageId: null });

    const limited = listMessagesForConversation(db, conversation.id, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0].body).toBe('two');
    expect(limited[1].body).toBe('three');
    db.close();
  });

  it('listRecentMessagesForConversation returns the most recent N messages, oldest-of-the-batch first', () => {
    const { db, alice, conversation } = freshDbWithConversation();
    for (const body of ['one', 'two', 'three', 'four']) {
      createMessage(db, { conversationId: conversation.id, authorId: alice.id, authorType: 'user', body, mentions: [], replyToMessageId: null });
    }
    const recent = listRecentMessagesForConversation(db, conversation.id, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].body).toBe('three');
    expect(recent[1].body).toBe('four');
    db.close();
  });
});
