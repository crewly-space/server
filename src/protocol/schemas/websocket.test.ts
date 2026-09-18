import { describe, expect, it } from 'vitest';
import { WsResumeRequestSchema, WsServerEventSchema } from './websocket.js';

describe('WsServerEventSchema', () => {
  it('parses a server-pushed event envelope', () => {
    const event = WsServerEventSchema.parse({
      seq: 42,
      topic: 'conversation:conversation_1',
      type: 'message.created',
      ts: '2026-01-01T00:00:00.000Z',
      payload: { id: 'message_1' },
    });
    expect(event.seq).toBe(42);
  });

  it('rejects seq below 1 (event_log is 1-indexed)', () => {
    expect(() =>
      WsServerEventSchema.parse({
        seq: 0,
        topic: 'conversation:conversation_1',
        type: 'message.created',
        ts: '2026-01-01T00:00:00.000Z',
        payload: {},
      })
    ).toThrow();
  });

  it('rejects an event with no payload key', () => {
    expect(() =>
      WsServerEventSchema.parse({
        seq: 42,
        topic: 'conversation:conversation_1',
        type: 'message.created',
        ts: '2026-01-01T00:00:00.000Z',
      })
    ).toThrow();
  });
});

describe('WsResumeRequestSchema', () => {
  it('parses a resume request with sinceSeq 0 for a brand-new client', () => {
    const resume = WsResumeRequestSchema.parse({ op: 'resume', sinceSeq: 0 });
    expect(resume.sinceSeq).toBe(0);
  });
});
