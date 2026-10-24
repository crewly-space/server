import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { createProviderConfig, getProviderConfig } from '../../src/providers/repository.js';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve()); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref();
  });
}

it.skipIf(!process.env.CREWLY_TEST_LIBSQL_SERVER)('authenticates against a real primary, persists a DM reply, and restores data on a fresh deployment', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'crewly-remote-'));
  const httpPort = await port(), grpcPort = await port();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubFile = join(directory, 'test-public.pem');
  writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ a: 'rw', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}`;
  const token = `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString('base64url')}`;
  const primary = spawn(process.env.CREWLY_TEST_LIBSQL_SERVER!, ['--db-path', join(directory, 'primary'), '--http-listen-addr', `127.0.0.1:${httpPort}`, '--grpc-listen-addr', `127.0.0.1:${grpcPort}`, '--auth-jwt-key-file', pubFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  primary.stdout!.on('data', (chunk) => { logs = (logs + chunk).slice(-5000); });
  primary.stderr!.on('data', (chunk) => { logs = (logs + chunk).slice(-5000); });
  const options = { turso: { url: `http://127.0.0.1:${httpPort}`, authToken: token }, managedSecretsKey: Buffer.alloc(32, 3).toString('base64') };
  let db: ReturnType<typeof openDatabase> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`http://127.0.0.1:${httpPort}/health`)).ok) { ready = true; break; } } catch { /* booting */ }
      if (primary.exitCode !== null) throw new Error(`Primary exited: ${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Primary did not become ready: ${logs}`);
    db = openDatabase(join(directory, 'first'), options); runMigrations(db);
    db.exec('CREATE TABLE transaction_probe (id TEXT PRIMARY KEY)');
    const insert = db.transaction(() => db!.prepare('INSERT INTO transaction_probe VALUES (@id)').run({ id: 'rolled-back' }));
    expect(() => db!.transaction(() => { insert(); throw new Error('abort'); })()).toThrow('abort');
    expect(db.prepare('SELECT COUNT(*) FROM transaction_probe').pluck().get()).toBe(0);
    db.exec('DROP TABLE transaction_probe');
    createProviderConfig(db, { id: 'test-provider', kind: 'anthropic', apiKey: 'test-secret-to-preserve' });
    app = await buildApp({ db, respond: async () => ({ body: 'Reply persisted on the remote primary.' }) });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { email: 'owner@example.test', displayName: 'Owner', password: 'strong-test-password' } });
    expect(setup.statusCode, setup.body).toBe(201);
    const headers = { authorization: `Bearer ${setup.json().token}` };
    const agent = await app.inject({ method: 'POST', url: '/api/v1/agents', headers, payload: { name: 'Assistant', personality: '', modelPolicy: { defaultProviderId: 'test-provider', defaultModel: 'test-model' } } });
    expect(agent.statusCode, agent.body).toBe(201);
    const conversation = await app.inject({ method: 'POST', url: '/api/v1/conversations', headers, payload: { participantId: agent.json().id, participantType: 'agent' } });
    expect(conversation.statusCode, conversation.body).toBe(201);
    const url = `/api/v1/conversations/${conversation.json().id}/messages`;
    const sent = await app.inject({ method: 'POST', url, headers, payload: { body: 'Hello' } });
    expect(sent.statusCode, sent.body).toBe(201);
    await expect.poll(async () => (await app!.inject({ method: 'GET', url, headers })).json().some((message: { body: string }) => message.body === 'Reply persisted on the remote primary.'), { timeout: 10000 }).toBe(true);
    await app.close(); app = undefined; db.close(); db = undefined;
    // A deployment with a new data directory reconnects to the authoritative primary.
    db = openDatabase(join(directory, 'new-deployment'), options);
    expect(runMigrations(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(getProviderConfig(db, 'test-provider')?.apiKey).toBe('test-secret-to-preserve');
    expect(db.prepare('SELECT body FROM messages ORDER BY created_at').pluck().all()).toEqual(['Hello', 'Reply persisted on the remote primary.']);
    db.close(); db = undefined;
    expect(() => openDatabase(join(directory, 'wrong-key'), { ...options, managedSecretsKey: Buffer.alloc(32, 9).toString('base64') })).toThrow(/original key/);
    expect(() => openDatabase(join(directory, 'wrong-token'), { ...options, turso: { ...options.turso, authToken: 'invalid' } })).toThrow(/Could not open libSQL/);
  } catch (error) { console.error(logs); throw error; } finally { await app?.close(); db?.close(); await stop(primary); rmSync(directory, { recursive: true, force: true }); }
}, 90000);
