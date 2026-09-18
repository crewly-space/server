import { describe, expect, it } from 'vitest';
import {
  AgentdAuthenticateSchema,
  AgentdChallengeSchema,
  AgentdHeartbeatSchema,
  AgentdOperationNameSchema,
  AgentdRequestSchema,
  AgentdResponseSchema,
} from './agentd.js';

describe('AgentdOperationNameSchema', () => {
  it('only allows the six documented high-level operations', () => {
    const allowed = [
      'runtime.run',
      'runtime.resume',
      'provider.chat',
      'provider.models',
      'workspace.list',
      'approval.respond',
    ];
    for (const op of allowed) {
      expect(() => AgentdOperationNameSchema.parse(op)).not.toThrow();
    }
    expect(() => AgentdOperationNameSchema.parse('shell.exec')).toThrow();
  });
});

describe('signed agentd connection messages', () => {
  it('parses challenge, authentication, and heartbeat messages', () => {
    expect(AgentdChallengeSchema.parse({ type: 'challenge', nonce: 'nonce' }).nonce).toBe('nonce');
    expect(AgentdAuthenticateSchema.parse({
      type: 'authenticate',
      deviceId: 'dev_0123456789abcdef0123',
      timestamp: '2026-09-18T00:00:00.000Z',
      nonce: 'nonce',
      signature: 'x'.repeat(40),
    }).deviceId).toBe('dev_0123456789abcdef0123');
    expect(AgentdHeartbeatSchema.parse({ type: 'heartbeat', capabilities: { providers: [] } }).capabilities)
      .toEqual({ providers: [] });
  });
});

describe('AgentdRequestSchema / AgentdResponseSchema', () => {
  it('parses a runtime.run request and a matching success response', () => {
    const request = AgentdRequestSchema.parse({
      requestId: 'req_1',
      operation: 'runtime.run',
      payload: { agentId: 'agent_1', conversationId: 'conversation_1' },
    });
    expect(request.operation).toBe('runtime.run');

    const response = AgentdResponseSchema.parse({
      requestId: 'req_1',
      ok: true,
      result: { runId: 'run_1' },
    });
    expect(response.ok).toBe(true);
  });

  it('parses a failure response carrying a structured error', () => {
    const response = AgentdResponseSchema.parse({
      requestId: 'req_2',
      ok: false,
      error: { code: 'provider_unavailable', message: 'no internet connection' },
    });
    expect(response.error?.code).toBe('provider_unavailable');
  });
});
