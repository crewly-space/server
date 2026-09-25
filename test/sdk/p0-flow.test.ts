import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.js';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CrewlyClient } from '../../src/sdk/client.js';

let provider: Server | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let db: ReturnType<typeof openDatabase> | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await app?.close();
  await new Promise<void>((resolve) => provider?.close(() => resolve()) ?? resolve());
  db?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

it('P0 clean setup → provider-backed DM → persisted WS reply → new client history', async () => {
  let providerInput: { model: string; messages: { role: string; content: string }[] } | undefined;
  provider = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    providerInput = JSON.parse(Buffer.concat(chunks).toString()) as typeof providerInput;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Hello from the real provider path' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('provider address');
  dataDir = mkdtempSync(join(tmpdir(), 'crewly-p0-'));
  db = openDatabase(dataDir);
  runMigrations(db);
  app = await buildApp({ db });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new CrewlyClient({ baseUrl });
  expect((await client.auth.status()).initialized).toBe(false);
  const setup = await client.auth.setup({ email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' });
  client.setToken(setup.token);
  await client.providers.create({ id: 'local-remote', kind: 'openai-compatible', apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1` });
  const agent = await client.agents.create({ name: 'Echo', personality: 'Be concise.',
    modelPolicy: { defaultProviderId: 'local-remote', defaultModel: 'test-model' } });
  const dm = await client.conversations.createDm({ participantId: agent.id, participantType: 'agent' });
  const ws = client.ws(WebSocket);
  const opened = new Promise<void>((resolve) => ws.onOpen(resolve));
  const delivered = new Promise<{ id: string; body: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for provider reply over WS')), 5000);
    ws.onEvent((event) => {
      if (event.type === 'message.created' && event.payload.authorType === 'agent') {
        clearTimeout(timeout); resolve(event.payload as { id: string; body: string });
      }
    });
  });
  ws.connect({ token: setup.token });
  await opened;
  const mine = await client.messages.send(dm.id, { body: 'Hello' });
  expect(mine.body).toBe('Hello');
  const reply = await delivered;
  expect(reply.body).toBe('Hello from the real provider path');
  expect(providerInput?.model).toBe('test-model');
  expect(providerInput?.messages[0]).toMatchObject({ role: 'system' });
  expect(providerInput?.messages[0]?.content).toMatch(/^Agent instructions: Be concise\./);
  // An agent with no tools is told so, rather than left to claim it can browse (CRE-107).
  expect(providerInput?.messages[0]?.content).toContain('you have no tools');
  expect(providerInput?.messages.at(-1)).toEqual({ role: 'user', content: 'Hello' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(dm.id)).toEqual({ n: 2 });
  ws.close();
  const reloaded = new CrewlyClient({ baseUrl });
  reloaded.setToken(setup.token);
  expect((await reloaded.conversations.list()).some((item) => item.id === dm.id)).toBe(true);
  expect((await reloaded.messages.list(dm.id)).map((item) => item.id)).toContain(reply.id);
  const login = await reloaded.auth.login({ email: 'owner@example.com', password: 'super-secret-1' });
  expect(login.user.id).toBe(setup.user.id);
  reloaded.setToken(login.token);
  await reloaded.auth.logout();
  await expect(reloaded.auth.me()).rejects.toMatchObject({ status: 401 });
});
