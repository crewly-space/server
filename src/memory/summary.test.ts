import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createMessage } from '../messages/repository.js';
import { getConversationSummary } from './summary-repository.js';
import { defaultSummarize, updateConversationSummary, type SummarizeFn } from './summary.js';

describe('conversation summary orchestration', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithConversation() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-summary-orch-'));
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
    return { db, alice, conversation };
  }

  it('returns undefined when the conversation has no messages yet', async () => {
    const { db, conversation } = freshDbWithConversation();
    const result = await updateConversationSummary(db, conversation.id);
    expect(result).toBeUndefined();
    db.close();
  });

  it('persists a summary built from the conversation messages using the default summarizer', async () => {
    const { db, alice, conversation } = freshDbWithConversation();
    createMessage(db, { conversationId: conversation.id, authorId: alice.id, authorType: 'user', body: 'first message', mentions: [], replyToMessageId: null });

    const result = await updateConversationSummary(db, conversation.id);

    expect(result?.summary).toContain('first message');
    expect(getConversationSummary(db, conversation.id)?.summary).toBe(result?.summary);
    db.close();
  });

  it('passes the prior summary text into the summarizer on a second call', async () => {
    const { db, alice, conversation } = freshDbWithConversation();
    createMessage(db, { conversationId: conversation.id, authorId: alice.id, authorType: 'user', body: 'first', mentions: [], replyToMessageId: null });
    await updateConversationSummary(db, conversation.id);

    createMessage(db, { conversationId: conversation.id, authorId: alice.id, authorType: 'user', body: 'second', mentions: [], replyToMessageId: null });
    const seenPriorSummaries: (string | null)[] = [];
    const spy: SummarizeFn = async (input) => {
      seenPriorSummaries.push(input.priorSummary);
      return 'stub summary';
    };
    await updateConversationSummary(db, conversation.id, spy);

    expect(seenPriorSummaries).toHaveLength(1);
    expect(seenPriorSummaries[0]).toContain('first');
    db.close();
  });

  it('uses an injected custom summarize function instead of the default', async () => {
    const { db, alice, conversation } = freshDbWithConversation();
    createMessage(db, { conversationId: conversation.id, authorId: alice.id, authorType: 'user', body: 'hello', mentions: [], replyToMessageId: null });
    const custom: SummarizeFn = async () => 'custom summary text';

    const result = await updateConversationSummary(db, conversation.id, custom);

    expect(result?.summary).toBe('custom summary text');
    db.close();
  });

  it('defaultSummarize is pure: same input always produces the same output', async () => {
    const messages = [
      { id: 'm1', conversationId: 'c1', authorId: 'u1', authorType: 'user' as const, body: 'hi', mentions: [], replyToMessageId: null, createdAt: new Date().toISOString() },
    ];
    const first = await defaultSummarize({ conversationId: 'c1', priorSummary: null, messages });
    const second = await defaultSummarize({ conversationId: 'c1', priorSummary: null, messages });
    expect(first).toBe(second);
  });
});
