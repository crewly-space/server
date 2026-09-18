import { describe, expect, it } from 'vitest';
import {
  AgentRunSchema,
  DEFAULT_MAX_HOP_COUNT,
  RuntimeBindingSchema,
  RuntimeSessionSchema,
} from './runtime.js';

describe('DEFAULT_MAX_HOP_COUNT', () => {
  it('is 4', () => {
    expect(DEFAULT_MAX_HOP_COUNT).toBe(4);
  });
});

describe('RuntimeBindingSchema', () => {
  it('stores vendor-specific session state off the Agent model', () => {
    const binding = RuntimeBindingSchema.parse({
      id: 'binding_1',
      agentId: 'agent_1',
      runtimeKind: 'claude-code',
      workspacePath: '/workspaces/agent_1',
      vendorState: { claudeSessionId: 'sess_abc123' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(binding.vendorState.claudeSessionId).toBe('sess_abc123');
  });

  it('rejects unknown runtime kinds', () => {
    expect(() =>
      RuntimeBindingSchema.parse({
        id: 'binding_1',
        agentId: 'agent_1',
        runtimeKind: 'not-a-real-runtime',
        workspacePath: '/workspaces/agent_1',
        vendorState: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    ).toThrow();
  });
});

describe('RuntimeSessionSchema', () => {
  it('composes Agent + Conversation + Runtime + Workspace via foreign keys', () => {
    const session = RuntimeSessionSchema.parse({
      id: 'session_1',
      agentId: 'agent_1',
      conversationId: 'conversation_1',
      runtimeBindingId: 'binding_1',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(session.status).toBe('running');
  });
});

describe('AgentRunSchema', () => {
  it('rejects hopCount above DEFAULT_MAX_HOP_COUNT', () => {
    expect(() =>
      AgentRunSchema.parse({
        runId: 'run_2',
        rootRunId: 'run_1',
        causationId: 'run_1',
        hopCount: DEFAULT_MAX_HOP_COUNT + 1,
        agentId: 'agent_1',
        conversationId: 'conversation_1',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    ).toThrow();
  });

  it('accepts a root run with hopCount 0 and null causationId', () => {
    const run = AgentRunSchema.parse({
      runId: 'run_1',
      rootRunId: 'run_1',
      causationId: null,
      hopCount: 0,
      agentId: 'agent_1',
      conversationId: 'conversation_1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(run.hopCount).toBe(0);
  });
});
