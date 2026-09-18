import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { ConversationsResource } from './conversations.js';

function clientWithFetch(handler: (method: string, path: string, body: unknown) => Response): HttpClient {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(init?.method ?? 'GET', path, body);
  }) as unknown as typeof fetch;
  return new HttpClient('http://localhost:4000', fetchImpl);
}

const CONVERSATION_FIXTURE = {
  id: 'conv_1',
  kind: 'dm',
  name: null,
  participants: [
    { participantId: 'u1', participantType: 'user' },
    { participantId: 'agent_1', participantType: 'agent' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('ConversationsResource', () => {
  it('createDm posts to /api/v1/conversations', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/conversations');
      expect(body).toEqual({ participantId: 'agent_1', participantType: 'agent' });
      return new Response(JSON.stringify(CONVERSATION_FIXTURE), { status: 201 });
    });
    const conversations = new ConversationsResource(http);

    const conversation = await conversations.createDm({ participantId: 'agent_1', participantType: 'agent' });

    expect(conversation.id).toBe('conv_1');
  });

  it('createGroup posts to /api/v1/conversations/group', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/conversations/group');
      expect(body).toEqual({ name: 'Team', participants: [{ participantId: 'u2', participantType: 'user' }] });
      return new Response(JSON.stringify({ ...CONVERSATION_FIXTURE, kind: 'group', name: 'Team' }), { status: 201 });
    });
    const conversations = new ConversationsResource(http);

    const conversation = await conversations.createGroup({ name: 'Team', participants: [{ participantId: 'u2', participantType: 'user' }] });

    expect(conversation.name).toBe('Team');
  });

  it('list gets /api/v1/conversations', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/conversations');
      return new Response(JSON.stringify([CONVERSATION_FIXTURE]), { status: 200 });
    });
    const conversations = new ConversationsResource(http);

    const list = await conversations.list();

    expect(list).toHaveLength(1);
  });

  it('addMember posts to /api/v1/conversations/:id/members and resolves without a value', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/conversations/conv_1/members');
      expect(body).toEqual({ participantId: 'u2', participantType: 'user' });
      return new Response(null, { status: 204 });
    });
    const conversations = new ConversationsResource(http);

    await expect(conversations.addMember('conv_1', { participantId: 'u2', participantType: 'user' })).resolves.toBeUndefined();
  });

  it('removeMember deletes /api/v1/conversations/:id/members/:participantId', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('DELETE');
      expect(path).toBe('/api/v1/conversations/conv_1/members/u2');
      return new Response(null, { status: 204 });
    });
    const conversations = new ConversationsResource(http);

    await expect(conversations.removeMember('conv_1', 'u2')).resolves.toBeUndefined();
  });
});
