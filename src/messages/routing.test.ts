import { describe, expect, it } from 'vitest';
import { decideAgentRouting, messageIsRelevantToAgent } from './routing.js';

const agent = { name: 'Release Helper', personality: 'You triage deployment incidents and release failures.', availability: 'auto' as const };

describe('message routing', () => {
  it('recognises lightweight profile relevance without invoking the provider', () => {
    expect(messageIsRelevantToAgent(agent, 'Can you triage this deployment incident?')).toBe(true);
    expect(messageIsRelevantToAgent(agent, 'What should we order for lunch?')).toBe(false);
  });

  it('lets an explicit mention address an agent in any non-blocked mode', () => {
    expect(decideAgentRouting(agent, 'disabled', '@Release Helper please look', true, false)).toMatchObject({
      shouldRespond: true,
      reason: 'explicit_mention',
    });
  });

  it('keeps direct messages available while the agent is in Do Not Disturb', () => {
    expect(decideAgentRouting({ ...agent, availability: 'dnd' }, 'always', 'hello', false, false, true)).toMatchObject({
      shouldRespond: true,
      reason: 'always',
    });
    expect(decideAgentRouting({ ...agent, availability: 'dnd' }, 'always', 'hello', false, false)).toMatchObject({
      shouldRespond: false,
      reason: 'dnd',
    });
  });

  it('keeps channel blocks as the permission boundary', () => {
    expect(decideAgentRouting(agent, 'always', 'deploy this', true, true)).toMatchObject({
      shouldRespond: false,
      reason: 'blocked',
    });
  });
});
