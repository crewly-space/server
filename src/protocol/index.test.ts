import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';

describe('protocol barrel export', () => {
  it('exposes every domain schema from a single entry point', () => {
    expect(protocol.PROTOCOL_VERSION).toBeDefined();
    expect(protocol.AgentSchema).toBeDefined();
    expect(protocol.RuntimeBindingSchema).toBeDefined();
    expect(protocol.RuntimeSessionSchema).toBeDefined();
    expect(protocol.ConversationSchema).toBeDefined();
    expect(protocol.MessageSchema).toBeDefined();
    expect(protocol.ProviderKindSchema).toBeDefined();
    expect(protocol.AgentdRequestSchema).toBeDefined();
    expect(protocol.MemoryFactSchema).toBeDefined();
    expect(protocol.WsServerEventSchema).toBeDefined();
    expect(protocol.ApprovalRequestSchema).toBeDefined();
  });
});
