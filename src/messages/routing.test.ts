import { describe, expect, it } from 'vitest';
import { decideAgentRouting, messageIsRelevantToAgent, messageNamesAgent, pickMessageOwner } from './routing.js';

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

  it('hears its name the way a colleague would', () => {
    expect(messageNamesAgent(agent, 'release helper, can you check?')).toBe(true);
    expect(messageNamesAgent(agent, 'thanks @Release Helper')).toBe(true);
    expect(messageNamesAgent({ name: 'Ada' }, 'the adapter is broken')).toBe(false);
  });

  it('answers follow-ups and threads in mention-only mode, but not when someone else is addressed', () => {
    expect(decideAgentRouting(agent, 'mention_only', 'and the tests?', false, false, false, { followUp: true })).toMatchObject({ shouldRespond: true, reason: 'follow_up' });
    expect(decideAgentRouting(agent, 'mention_only', 'more?', false, false, false, { inThread: true })).toMatchObject({ shouldRespond: true, reason: 'thread' });
    expect(decideAgentRouting(agent, 'mention_only', 'Beta?', false, false, false, { followUp: true, addressedElsewhere: true })).toMatchObject({ shouldRespond: false });
    expect(decideAgentRouting(agent, 'mention_only', 'hi', false, false, false, { named: true })).toMatchObject({ shouldRespond: true, reason: 'named' });
    expect(decideAgentRouting(agent, 'disabled', 'hi', false, false, false, { named: true, followUp: true })).toMatchObject({ shouldRespond: false, reason: 'disabled' });
  });

  it('picks the one colleague a message is about, and nobody on a tie or small talk', () => {
    const crew = [
      { agentId: 'qa', agent: { name: 'Quinn', personality: 'QA Engineer\nYou keep the test suite green.' } },
      { agentId: 'dev', agent: { name: 'Devon', personality: 'Backend Engineer\nYou build APIs.' } },
      { agentId: 'ops', agent: { name: 'Ollie', personality: 'DevOps\nYou own deploys and incidents.' } },
    ];
    expect(pickMessageOwner(crew, 'how are the tests going?')).toBe('qa');
    expect(pickMessageOwner(crew, 'is the deployment done?')).toBe('ops');
    expect(pickMessageOwner(crew, 'can someone fix the login bug in the api')).toBe('dev');
    expect(pickMessageOwner(crew, 'what should we order for lunch?')).toBeUndefined();
    expect(pickMessageOwner(crew, 'good morning everyone')).toBeUndefined();
  });
});
