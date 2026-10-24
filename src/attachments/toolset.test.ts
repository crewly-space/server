import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createConversation, removeParticipant } from '../conversations/repository.js';
import { createMessage, listRecentMessagesForConversation } from '../messages/repository.js';
import { AttachmentStore, createAttachment } from './service.js';
import { attachmentToolset } from './toolset.js';
import type { AgentToolset } from '../providers/respond.js';

let db: Database, directory: string, store: AttachmentStore, tools: AgentToolset;
let owner: ReturnType<typeof createUser>, agent: ReturnType<typeof createAgent>, conversationId: string;
let fileId: string;
beforeEach(async () => {
  db = openSqlite(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
  directory = mkdtempSync(tmpdir() + '/crewly-text-'); store = new AttachmentStore(directory);
  owner = createUser(db, { email: 'owner@example.test', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
  agent = createAgent(db, { ownerUserId: owner.id, name: 'Helper', personality: '', modelPolicy: { defaultProviderId: 'p', defaultModel: 'm' }, permissions: { tools: [], canMessageAgents: false, canApproveOwnActions: false } });
  conversationId = createConversation(db, { kind: 'dm', name: null, participants: [{ participantId: owner.id, participantType: 'user' }, { participantId: agent.id, participantType: 'agent' }] }).id;
  const file = createAttachment(db, store, { conversationId, uploadedBy: owner.id, filename: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('Zażółć gęślą jaźń.\nA useful note.') });
  fileId = file.id;
  createMessage(db, { conversationId, authorId: owner.id, authorType: 'user', body: 'Read my note', mentions: [], replyToMessageId: null, attachmentIds: [fileId] });
  tools = (await attachmentToolset(db, store)(agent, { agentId: agent.id, conversationId, recentMessages: listRecentMessagesForConversation(db, conversationId) }))!;
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const read = (id: string, extra = {}) => tools.execute({ id: 'read', name: 'read_attachment', input: { id, ...extra } });
it('reads attached UTF-8 text in pages with explicit end of file', async () => {
  const first = JSON.parse((await read(fileId, { limit: 7 })).content);
  expect(first).toMatchObject({ filename: 'notes.md', text: 'Zażółć ', nextOffset: 7 });
  const rest = JSON.parse((await read(fileId, { offset: first.nextOffset })).content);
  expect(first.text + rest.text).toBe('Zażółć gęślą jaźń.\nA useful note.');
  expect(rest.nextOffset).toBeNull();
});
it('refuses unposted files, unknown ids, and access revoked after the turn began', async () => {
  const pending = createAttachment(db, store, { conversationId, uploadedBy: owner.id, filename: 'private.txt', mimeType: 'text/plain', data: Buffer.from('private') });
  expect((await read(pending.id)).isError).toBe(true);
  expect((await read('missing')).isError).toBe(true);
  removeParticipant(db, conversationId, agent.id);
  expect((await read(fileId)).isError).toBe(true);
});
it('does not claim binary contents were read', async () => {
  const file = createAttachment(db, store, { conversationId, uploadedBy: owner.id, filename: 'scan.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF test') });
  createMessage(db, { conversationId, authorId: owner.id, authorType: 'user', body: 'Read this', mentions: [], replyToMessageId: null, attachmentIds: [file.id] });
  tools = (await attachmentToolset(db, store)(agent, { agentId: agent.id, conversationId, recentMessages: listRecentMessagesForConversation(db, conversationId) }))!;
  expect(await read(file.id)).toMatchObject({ isError: true, content: expect.stringContaining('format_not_supported') });
});
