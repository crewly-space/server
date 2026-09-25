import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createSession } from '../auth/session.js';
import { createUser } from '../users/repository.js';

describe('attachment routes', () => {
  let db: Database;
  let directory: string;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-attachments-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function setupDm(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const ownerToken = setup.json().token as string;
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const conversation = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { participantId: bob.id, participantType: 'user' },
    });
    return {
      ownerToken,
      bobToken: createSession(db, bob.id),
      outsiderToken: createSession(db, createUser(db, { email: 'outsider@example.com', displayName: 'Outsider', passwordHash: 'x', role: 'member' }).id),
      conversationId: conversation.json().id as string,
    };
  }

  it('uploads, links, lists, downloads, and authorizes a message attachment', async () => {
    const app = await buildApp({ db, attachmentDir: directory });
    const { ownerToken, bobToken, outsiderToken, conversationId } = await setupDm(app);
    const payload = Buffer.from('hello attachment').toString('base64');

    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { conversationId, filename: '../notes.txt', mimeType: 'text/plain', dataBase64: payload },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({ filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 16, messageId: null });
    const attachmentId = upload.json().id as string;

    const message = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { body: '', attachmentIds: [attachmentId] },
    });
    expect(message.statusCode).toBe(201);
    expect(message.json().body).toBe('');
    expect(message.json().attachments).toHaveLength(1);
    expect(message.json().attachments[0].messageId).toBe(message.json().id);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(listed.json()[0].attachments[0].filename).toBe('notes.txt');

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload.toString('utf8')).toBe('hello attachment');
    expect(downloaded.headers['content-disposition']).toContain('notes.txt');

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(forbidden.statusCode).toBe(404);

    const attachedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(attachedDelete.statusCode).toBe(404);
    await app.close();
  });

  it('allows an uploader to remove a pending attachment and rejects unsupported types', async () => {
    const app = await buildApp({ db, attachmentDir: directory });
    const { ownerToken, conversationId } = await setupDm(app);
    const common = { conversationId, filename: 'file.bin', dataBase64: Buffer.from('data').toString('base64') };

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { ...common, mimeType: 'application/x-msdownload' },
    });
    expect(unsupported.statusCode).toBe(400);

    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { ...common, mimeType: 'application/json' },
    });
    expect(upload.statusCode).toBe(201);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/attachments/${upload.json().id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(removed.statusCode).toBe(204);
    await app.close();
  });
});
