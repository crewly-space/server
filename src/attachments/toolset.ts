import { z } from 'zod';
import type { Database } from '../db/driver.js';
import type { ToolsetProvider } from '../providers/respond.js';
import { isParticipant } from '../conversations/repository.js';
import { canReadChannel, blockedAgentIds } from '../channels/repository.js';
import { AttachmentStore, getAttachment } from './service.js';

const ReadInput = z.object({ id: z.string().min(1), offset: z.number().int().min(0).max(10_000_000).default(0),
  limit: z.number().int().min(1).max(50_000).default(20_000) }).strict();

/** Read only files actually attached to messages in this turn's conversation. */
export function attachmentToolset(db: Database, store: AttachmentStore): ToolsetProvider {
  return (agent, input) => {
    const ids = new Set(input.recentMessages.flatMap((message) => message.attachments?.map((attachment) => attachment.id) ?? []));
    if (!ids.size) return undefined;
    return {
      instructions: 'Messages may include attachment metadata, not their contents. Use read_attachment before describing an attached text file. It reads text, Markdown, CSV, JSON, and SVG; binary files such as PDF, office documents and photos require a different available tool. Never claim to have read unsupported content.',
      definitions: [{ name: 'read_attachment', description: 'Read UTF-8 text from a file attached in this conversation. Supports paging with character offset and limit; nextOffset is null at the end.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50_000 } }, required: ['id'], additionalProperties: false } }],
      async execute(call) {
        try {
          const { id, offset, limit } = ReadInput.parse(call.input);
          const row = getAttachment(db, id);
          const human = [...input.recentMessages].reverse().find((message) => message.authorType === 'user');
          if (!ids.has(id) || !row?.message_id || row.conversation_id !== input.conversationId
            || !isParticipant(db, input.conversationId, agent.id, 'agent') || blockedAgentIds(db, input.conversationId).includes(agent.id)
            || (human && !isParticipant(db, input.conversationId, human.authorId, 'user') && !canReadChannel(db, input.conversationId, human.authorId))) {
            throw new Error('attachment_not_available');
          }
          if (!row.mime_type.startsWith('text/') && !['application/json', 'image/svg+xml'].includes(row.mime_type)) throw new Error('attachment_format_not_supported: use a text, Markdown, CSV or JSON file');
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let text = '', complete = true;
          for await (const chunk of store.read(row.storage_key)) {
            text += decoder.decode(chunk as Buffer, { stream: true });
            if (text.length > offset + limit) { complete = false; break; }
          }
          if (complete) text += decoder.decode();
          const content = text.slice(offset, offset + limit);
          return { content: JSON.stringify({ filename: row.filename, mimeType: row.mime_type, offset, text: content,
            nextOffset: !complete || text.length > offset + limit ? offset + content.length : null }) };
        } catch (reason) { return { content: reason instanceof Error ? reason.message : 'attachment_read_failed', isError: true }; }
      },
    };
  };
}
