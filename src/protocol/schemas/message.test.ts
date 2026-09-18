import { describe, expect, it } from 'vitest';
import { MessageSchema } from './message.js';

const now = '2026-01-01T00:00:00.000Z';

describe('MessageSchema', () => {
  it('parses a message with a mention and a reply', () => {
    const message = MessageSchema.parse({
      id: 'message_2',
      conversationId: 'conversation_1',
      authorId: 'agent_1',
      authorType: 'agent',
      body: '@user_1 following up on that',
      mentions: [{ targetId: 'user_1', targetType: 'user' }],
      replyToMessageId: 'message_1',
      createdAt: now,
    });
    expect(message.replyToMessageId).toBe('message_1');
  });

  it('defaults mentions to an empty array and allows a null replyToMessageId', () => {
    const message = MessageSchema.parse({
      id: 'message_1',
      conversationId: 'conversation_1',
      authorId: 'user_1',
      authorType: 'user',
      body: 'hello',
      replyToMessageId: null,
      createdAt: now,
    });
    expect(message.mentions).toEqual([]);
  });

  it('rejects an empty body', () => {
    expect(() =>
      MessageSchema.parse({
        id: 'message_3',
        conversationId: 'conversation_1',
        authorId: 'user_1',
        authorType: 'user',
        body: '',
        replyToMessageId: null,
        createdAt: now,
      })
    ).toThrow();
  });
});
