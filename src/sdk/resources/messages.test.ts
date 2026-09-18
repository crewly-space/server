import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { MessagesResource } from './messages.js';

function clientWithFetch(handler: (method: string, path: string, body: unknown) => Response): HttpClient {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const fullUrl = new URL(String(url));
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(init?.method ?? 'GET', fullUrl.pathname + fullUrl.search, body);
  }) as unknown as typeof fetch;
  return new HttpClient('http://localhost:4000', fetchImpl);
}

const MESSAGE_FIXTURE = {
  id: 'msg_1',
  conversationId: 'conv_1',
  authorId: 'u1',
  authorType: 'user',
  body: 'hello',
  mentions: [],
  replyToMessageId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('MessagesResource', () => {
  it('send posts to /api/v1/conversations/:id/messages', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/conversations/conv_1/messages');
      expect(body).toEqual({ body: 'hello' });
      return new Response(JSON.stringify(MESSAGE_FIXTURE), { status: 201 });
    });
    const messages = new MessagesResource(http);

    const message = await messages.send('conv_1', { body: 'hello' });

    expect(message.id).toBe('msg_1');
  });

  it('list gets /api/v1/conversations/:id/messages with a limit query param', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/conversations/conv_1/messages?limit=10');
      return new Response(JSON.stringify([MESSAGE_FIXTURE]), { status: 200 });
    });
    const messages = new MessagesResource(http);

    const list = await messages.list('conv_1', 10);

    expect(list).toHaveLength(1);
  });

  it('list omits the limit query param when none is given', async () => {
    const http = clientWithFetch((method, path) => {
      expect(path).toBe('/api/v1/conversations/conv_1/messages');
      return new Response(JSON.stringify([MESSAGE_FIXTURE]), { status: 200 });
    });
    const messages = new MessagesResource(http);

    await messages.list('conv_1');
  });
});
