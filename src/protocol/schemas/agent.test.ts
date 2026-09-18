import { describe, expect, it } from 'vitest';
import { AgentSchema, FORBIDDEN_AGENT_FIELDS } from './agent.js';

const validAgent = {
  id: 'agent_1',
  ownerUserId: 'user_1',
  name: 'Researcher',
  personality: 'Curious and terse.',
  modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
  permissions: { tools: ['web_search'], canMessageAgents: true, canApproveOwnActions: false },
  relationships: [{ agentId: 'agent_2', label: 'collaborator' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AgentSchema', () => {
  it('parses a valid agent', () => {
    expect(() => AgentSchema.parse(validAgent)).not.toThrow();
  });

  it('applies default permissions/relationships when omitted', () => {
    const { relationships, permissions, ...withoutDefaults } = validAgent;
    const parsed = AgentSchema.parse(withoutDefaults);
    expect(parsed.relationships).toEqual([]);
    expect(parsed.permissions).toEqual({
      tools: [],
      canMessageAgents: true,
      canApproveOwnActions: false,
    });
  });

  it.each(FORBIDDEN_AGENT_FIELDS)('rejects vendor session field %s on the core Agent model', (field) => {
    const tainted = { ...validAgent, [field]: 'vendor-specific-value' };
    expect(() => AgentSchema.parse(tainted)).toThrow();
  });
});
