import { describe, expect, it } from 'vitest';
import { ConversationSchema } from './conversation.js';

const now = '2026-01-01T00:00:00.000Z';

describe('ConversationSchema', () => {
  it('parses a valid dm with exactly two participants', () => {
    const dm = ConversationSchema.parse({
      id: 'conversation_1',
      kind: 'dm',
      name: null,
      participants: [
        { participantId: 'user_1', participantType: 'user' },
        { participantId: 'agent_1', participantType: 'agent' },
      ],
      createdAt: now,
      updatedAt: now,
    });
    expect(dm.participants).toHaveLength(2);
  });

  it('rejects a group conversation without a name', () => {
    expect(() =>
      ConversationSchema.parse({
        id: 'conversation_2',
        kind: 'group',
        name: null,
        participants: [
          { participantId: 'user_1', participantType: 'user' },
          { participantId: 'user_2', participantType: 'user' },
        ],
        createdAt: now,
        updatedAt: now,
      })
    ).toThrow();
  });

  it('rejects a conversation with fewer than two participants', () => {
    expect(() =>
      ConversationSchema.parse({
        id: 'conversation_3',
        kind: 'dm',
        name: null,
        participants: [{ participantId: 'user_1', participantType: 'user' }],
        createdAt: now,
        updatedAt: now,
      })
    ).toThrow();
  });

  it('rejects too many participants for a dm', () => {
    expect(() =>
      ConversationSchema.parse({
        id: 'conversation_4',
        kind: 'dm',
        name: null,
        participants: [
          { participantId: 'user_1', participantType: 'user' },
          { participantId: 'user_2', participantType: 'user' },
          { participantId: 'user_3', participantType: 'user' },
        ],
        createdAt: now,
        updatedAt: now,
      })
    ).toThrow();
  });
});
