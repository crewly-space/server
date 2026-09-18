import { describe, expect, it } from 'vitest';
import { ConversationSummarySchema, MemoryFactSchema } from './memory.js';

const now = '2026-01-01T00:00:00.000Z';

describe('MemoryFactSchema', () => {
  it('parses an inspectable, taggable fact', () => {
    const fact = MemoryFactSchema.parse({
      id: 'fact_1',
      agentId: 'agent_1',
      content: 'The user prefers terse responses.',
      source: 'conversation',
      tags: ['preferences'],
      createdAt: now,
      updatedAt: now,
    });
    expect(fact.tags).toEqual(['preferences']);
  });

  it('rejects empty content (nothing to inspect/dedupe against)', () => {
    expect(() =>
      MemoryFactSchema.parse({
        id: 'fact_2',
        agentId: 'agent_1',
        content: '',
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      })
    ).toThrow();
  });
});

describe('ConversationSummarySchema', () => {
  it('parses a rolling summary anchored to a message', () => {
    const summary = ConversationSummarySchema.parse({
      conversationId: 'conversation_1',
      summary: 'Discussed launch plan; agreed on 2026-03-01 date.',
      upToMessageId: 'message_42',
      updatedAt: now,
    });
    expect(summary.upToMessageId).toBe('message_42');
  });
});
