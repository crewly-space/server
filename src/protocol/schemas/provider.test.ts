import { describe, expect, it } from 'vitest';
import {
  AGENTD_BACKED_PROVIDER_KINDS,
  ChatRequestSchema,
  ChatResponseSchema,
  ProviderKindSchema,
  REMOTE_PROVIDER_KINDS,
} from './provider.js';

describe('ProviderKindSchema', () => {
  it('accepts every documented remote and agentd-backed kind', () => {
    for (const kind of [...REMOTE_PROVIDER_KINDS, ...AGENTD_BACKED_PROVIDER_KINDS]) {
      expect(() => ProviderKindSchema.parse(kind)).not.toThrow();
    }
  });

  it('includes claude-subscription and ollama as agentd-backed, not remote', () => {
    expect(AGENTD_BACKED_PROVIDER_KINDS).toContain('claude-subscription');
    expect(AGENTD_BACKED_PROVIDER_KINDS).toContain('ollama');
    expect(REMOTE_PROVIDER_KINDS).not.toContain('claude-subscription');
  });
});

describe('ChatRequestSchema / ChatResponseSchema', () => {
  it('round-trips a minimal chat exchange', () => {
    const request = ChatRequestSchema.parse({
      providerId: 'anthropic-default',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(request.messages).toHaveLength(1);

    const response = ChatResponseSchema.parse({
      providerId: 'anthropic-default',
      model: 'claude-sonnet-5',
      content: 'hi there',
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 3 },
    });
    expect(response.stopReason).toBe('end_turn');
  });

  it('rejects a chat request with zero messages', () => {
    expect(() =>
      ChatRequestSchema.parse({ providerId: 'anthropic-default', model: 'claude-sonnet-5', messages: [] })
    ).toThrow();
  });
});
