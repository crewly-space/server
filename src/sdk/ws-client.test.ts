import { describe, expect, it, vi } from 'vitest';
import type { WsServerEvent } from '../protocol/index.js';
import { WsClient, type WebSocketConstructor } from './ws-client.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  emitMessage(event: WsServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

function freshFakeWebSocketImpl(): WebSocketConstructor {
  FakeWebSocket.instances = [];
  return FakeWebSocket;
}

const EVENT_FIXTURE: WsServerEvent = {
  seq: 1,
  topic: 'conversation:conv_1',
  type: 'message.created',
  ts: '2026-01-01T00:00:00.000Z',
  payload: { body: 'hello' },
};

describe('WsClient', () => {
  it('connect opens a socket with the token in the query string', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);

    client.connect({ token: 'tok_1' });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:4000/api/v1/ws?token=tok_1');
  });

  it('connect includes sinceSeq in the query string when given', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);

    client.connect({ token: 'tok_1', sinceSeq: 42 });

    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:4000/api/v1/ws?token=tok_1&sinceSeq=42');
  });

  it('translates an http:// baseUrl to ws:// and https:// to wss://', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('https://api.example.com', WebSocketImpl);

    client.connect({ token: 'tok_1' });

    expect(FakeWebSocket.instances[0].url).toBe('wss://api.example.com/api/v1/ws?token=tok_1');
  });

  it('joins /ws without a duplicate slash when baseUrl ends in a slash', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000/', WebSocketImpl);

    client.connect({ token: 'tok_1' });

    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:4000/api/v1/ws?token=tok_1');
  });

  it('onOpen fires when the underlying socket opens', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);
    const opened = vi.fn();
    client.onOpen(opened);

    client.connect({ token: 'tok_1' });
    FakeWebSocket.instances[0].onopen?.();

    expect(opened).toHaveBeenCalledOnce();
  });

  it('dispatches incoming events to registered handlers', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);
    const handler = vi.fn();
    client.onEvent(handler);

    client.connect({ token: 'tok_1' });
    FakeWebSocket.instances[0].emitMessage(EVENT_FIXTURE);

    expect(handler).toHaveBeenCalledWith(EVENT_FIXTURE);
  });

  it('tracks the highest seq observed via getLastSeq', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);

    client.connect({ token: 'tok_1' });
    expect(client.getLastSeq()).toBeUndefined();

    FakeWebSocket.instances[0].emitMessage(EVENT_FIXTURE);
    expect(client.getLastSeq()).toBe(1);

    FakeWebSocket.instances[0].emitMessage({ ...EVENT_FIXTURE, seq: 5 });
    expect(client.getLastSeq()).toBe(5);
  });

  it('close closes the underlying socket', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);
    client.connect({ token: 'tok_1' });

    client.close();

    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  it('handles transport errors while the close event owns reconnection', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);

    client.connect({ token: 'tok_1' });

    expect(FakeWebSocket.instances[0].onerror).toBeTypeOf('function');
    expect(() => FakeWebSocket.instances[0].onerror?.()).not.toThrow();
  });

  it('reconnect closes the old socket and opens a new one replaying from the last observed seq', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);
    client.connect({ token: 'tok_1' });
    FakeWebSocket.instances[0].emitMessage({ ...EVENT_FIXTURE, seq: 7 });

    client.reconnect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(FakeWebSocket.instances[1].url).toBe('ws://localhost:4000/api/v1/ws?token=tok_1&sinceSeq=7');
  });

  it('reconnect preserves an explicit sinceSeq before any event arrives', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);
    client.connect({ token: 'tok_1', sinceSeq: 42 });

    client.reconnect();

    expect(FakeWebSocket.instances[1].url).toBe('ws://localhost:4000/api/v1/ws?token=tok_1&sinceSeq=42');
  });

  it('automatically replays after a dropped socket and deduplicates replayed events', () => {
    vi.useFakeTimers();
    try {
      const WebSocketImpl = freshFakeWebSocketImpl();
      const client = new WsClient('http://localhost:4000', WebSocketImpl);
      const handler = vi.fn();
      client.onEvent(handler);
      client.connect({ token: 'tok_1' });
      FakeWebSocket.instances[0].emitMessage({ ...EVENT_FIXTURE, seq: 7 });
      FakeWebSocket.instances[0].onclose?.();
      vi.advanceTimersByTime(1000);
      expect(FakeWebSocket.instances[1].url).toContain('sinceSeq=7');
      FakeWebSocket.instances[1].emitMessage({ ...EVENT_FIXTURE, seq: 7 });
      FakeWebSocket.instances[1].emitMessage({ ...EVENT_FIXTURE, seq: 8 });
      expect(handler).toHaveBeenCalledTimes(2);
      client.close();
    } finally { vi.useRealTimers(); }
  });

  it('ignores late messages from the socket replaced by reconnect', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);
    const handler = vi.fn();
    client.onEvent(handler);
    client.connect({ token: 'tok_1' });
    const oldSocket = FakeWebSocket.instances[0];

    client.reconnect();
    oldSocket.emitMessage({ ...EVENT_FIXTURE, seq: 2 });
    FakeWebSocket.instances[1].emitMessage({ ...EVENT_FIXTURE, seq: 2 });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('connect retires an existing socket before opening its replacement', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);
    const handler = vi.fn();
    client.onEvent(handler);
    client.connect({ token: 'tok_1' });
    const oldSocket = FakeWebSocket.instances[0];

    client.connect({ token: 'tok_2' });
    oldSocket.emitMessage({ ...EVENT_FIXTURE, seq: 2 });
    FakeWebSocket.instances[1].emitMessage({ ...EVENT_FIXTURE, seq: 2 });

    expect(oldSocket.closed).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reconnect throws if connect was never called (nothing to reconnect with)', () => {
    const WebSocketImpl = freshFakeWebSocketImpl();
    const client = new WsClient('http://localhost:4000', WebSocketImpl);

    expect(() => client.reconnect()).toThrow();
  });
});
