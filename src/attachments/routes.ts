import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { canReadChannel, getChannel } from '../channels/repository.js';
import { getConversation, isParticipant } from '../conversations/repository.js';
import type { Role } from '../users/repository.js';
import {
  AttachmentNotOwnedError,
  AttachmentStore,
  AttachmentValidationError,
  createAttachment,
  decodeBase64,
  getAttachment,
  pruneAttachments,
  removePendingAttachment,
} from './service.js';

const UploadSchema = z.object({
  conversationId: z.string().min(1),
  filename: z.string().min(1).max(300),
  mimeType: z.string().min(1).max(120),
  dataBase64: z.string().min(1),
});

function canUseConversation(app: FastifyInstance, request: FastifyRequest, conversationId: string): boolean {
  const conversation = getConversation(app.db, conversationId);
  if (!conversation) return false;
  if (isParticipant(app.db, conversationId, request.user!.id, 'user')) {
    if (conversation.kind !== 'channel') return true;
    return Boolean(getChannel(app.db, conversationId, { id: request.user!.id, role: request.user!.role as Role })?.canPost);
  }
  return false;
}

function canReadAttachment(app: FastifyInstance, request: FastifyRequest, conversationId: string): boolean {
  if (isParticipant(app.db, conversationId, request.user!.id, 'user')) return true;
  return canReadChannel(app.db, conversationId, request.user!.id);
}

function sendAttachmentError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AttachmentValidationError) { reply.code(400).send({ error: 'invalid_attachment', message: error.message }); return; }
  if (error instanceof AttachmentNotOwnedError) { reply.code(409).send({ error: 'attachment_unavailable', message: error.message }); return; }
  throw error;
}

export function registerAttachmentRoutes(app: FastifyInstance, options: { directory: string; maxBytes: number; store?: AttachmentStore }): void {
  const store = options.store ?? new AttachmentStore(options.directory, options.maxBytes);
  pruneAttachments(dbFor(app), store);

  app.post('/api/v1/attachments', { preHandler: requireAuth }, async (request, reply) => {
    pruneAttachments(dbFor(app), store);
    const body = UploadSchema.parse(request.body);
    if (!canUseConversation(app, request, body.conversationId)) {
      reply.code(403).send({ error: 'attachment_conversation_forbidden' });
      return;
    }
    try {
      const data = decodeBase64(body.dataBase64);
      reply.code(201).send(createAttachment(dbFor(app), store, {
        conversationId: body.conversationId,
        uploadedBy: request.user!.id,
        filename: body.filename,
        mimeType: body.mimeType,
        data,
      }));
    } catch (error) { sendAttachmentError(reply, error); }
  });

  app.get('/api/v1/attachments/:id', { preHandler: requireAuth }, async (request, reply) => {
    const row = getAttachment(dbFor(app), (request.params as { id: string }).id);
    if (!row || !canReadAttachment(app, request, row.conversation_id)) {
      reply.code(404).send({ error: 'attachment_not_found' });
      return;
    }
    return reply
      .header('cache-control', 'private, no-store')
      .header('content-type', row.mime_type)
      .header('content-length', row.size_bytes)
      .header('content-disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`)
      .send(store.read(row.storage_key));
  });

  app.delete('/api/v1/attachments/:id', { preHandler: requireAuth }, async (request, reply) => {
    const removed = removePendingAttachment(dbFor(app), store, (request.params as { id: string }).id, request.user!.id);
    if (!removed) { reply.code(404).send({ error: 'pending_attachment_not_found' }); return; }
    reply.code(204).send();
  });
}

// Fastify's decorated database is typed in app.ts; this local helper keeps
// the route module independent of the app's declaration-merging file.
function dbFor(app: FastifyInstance) {
  return (app as FastifyInstance & { db: import('../db/driver.js').Database }).db;
}
