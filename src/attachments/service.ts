import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';

export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT_PER_MESSAGE = 10;

export const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp',
  'text/csv', 'text/markdown', 'text/plain',
  'application/gzip', 'application/json', 'application/pdf', 'application/zip', 'application/x-gzip', 'application/x-tar',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const PENDING_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface AttachmentView {
  id: string;
  conversationId: string;
  messageId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  url: string;
  artifact: { id: string; runId: string; agentId: string } | null;
}

interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  uploaded_by: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  created_at: string;
  artifact_id?: string | null;
  artifact_run_id?: string | null;
  artifact_agent_id?: string | null;
}

export class AttachmentValidationError extends Error {}
export class AttachmentNotOwnedError extends Error {}

export class AttachmentStore {
  readonly directory: string;
  readonly maxBytes: number;

  constructor(directory: string, maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES) {
    this.directory = path.resolve(directory);
    this.maxBytes = maxBytes;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  write(storageKey: string, data: Buffer): void {
    if (data.length > this.maxBytes) throw new AttachmentValidationError(`attachments must be ${this.maxBytes} bytes or smaller`);
    const target = this.filePath(storageKey);
    const temporary = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  read(storageKey: string): fs.ReadStream {
    return fs.createReadStream(this.filePath(storageKey));
  }

  remove(storageKey: string): void {
    try { fs.unlinkSync(this.filePath(storageKey)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private filePath(storageKey: string): string {
    if (!/^[0-9a-f-]{36}\.bin$/.test(storageKey)) throw new Error('invalid_attachment_storage_key');
    return path.join(this.directory, storageKey);
  }
}

export function sanitizeFilename(input: string): string {
  const cleaned = path.basename(input.trim())
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
    .slice(0, 160);
  return cleaned || 'attachment';
}

export function decodeBase64(input: string): Buffer {
  const normalized = input.trim();
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new AttachmentValidationError('attachment data must be valid base64');
  }
  return Buffer.from(normalized, 'base64');
}

function view(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    url: `/api/v1/attachments/${encodeURIComponent(row.id)}`,
    artifact: row.artifact_id && row.artifact_run_id && row.artifact_agent_id
      ? { id: row.artifact_id, runId: row.artifact_run_id, agentId: row.artifact_agent_id }
      : null,
  };
}

export function attachmentView(row: AttachmentRow): AttachmentView { return view(row); }

export function getAttachment(db: Database, id: string): AttachmentRow | undefined {
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
}

export function listAttachmentsForMessage(db: Database, messageId: string): AttachmentView[] {
  return (db.prepare(
    `SELECT a.*, ar.attachment_id AS artifact_id, ar.run_id AS artifact_run_id, ar.agent_id AS artifact_agent_id
     FROM attachments a LEFT JOIN artifacts ar ON ar.attachment_id = a.id
     WHERE a.message_id = ? ORDER BY a.created_at ASC`,
  ).all(messageId) as AttachmentRow[]).map(view);
}

export function attachmentViewWithArtifact(db: Database, id: string): AttachmentView | undefined {
  const row = db.prepare(
    `SELECT a.*, ar.attachment_id AS artifact_id, ar.run_id AS artifact_run_id, ar.agent_id AS artifact_agent_id
     FROM attachments a LEFT JOIN artifacts ar ON ar.attachment_id = a.id WHERE a.id = ?`,
  ).get(id) as AttachmentRow | undefined;
  return row ? view(row) : undefined;
}

export function createAttachment(
  db: Database,
  store: AttachmentStore,
  input: { conversationId: string; uploadedBy: string; filename: string; mimeType: string; data: Buffer },
): AttachmentView {
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!ALLOWED_ATTACHMENT_TYPES.has(mimeType)) throw new AttachmentValidationError(`unsupported attachment type: ${mimeType || 'unknown'}`);
  if (input.data.length < 1) throw new AttachmentValidationError('attachments cannot be empty');
  if (input.data.length > store.maxBytes) throw new AttachmentValidationError(`attachments must be ${store.maxBytes} bytes or smaller`);

  const id = randomUUID();
  const storageKey = `${id}.bin`;
  const now = new Date().toISOString();
  store.write(storageKey, input.data);
  try {
    db.prepare(
      `INSERT INTO attachments (id, conversation_id, message_id, uploaded_by, filename, mime_type, size_bytes, storage_key, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.conversationId, input.uploadedBy, sanitizeFilename(input.filename), mimeType, input.data.length, storageKey, now);
  } catch (error) {
    store.remove(storageKey);
    throw error;
  }
  return view(getAttachment(db, id)!);
}

export function attachToMessage(
  db: Database,
  input: { messageId: string; conversationId: string; uploadedBy: string; attachmentIds: string[] },
): void {
  const ids = [...new Set(input.attachmentIds)];
  if (ids.length > ATTACHMENT_MAX_COUNT_PER_MESSAGE) throw new AttachmentValidationError(`a message can contain at most ${ATTACHMENT_MAX_COUNT_PER_MESSAGE} attachments`);
  for (const id of ids) {
    const row = getAttachment(db, id);
    if (!row || row.message_id || row.conversation_id !== input.conversationId || row.uploaded_by !== input.uploadedBy) {
      throw new AttachmentNotOwnedError('attachment is not available to this message');
    }
  }
  const update = db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL');
  for (const id of ids) update.run(input.messageId, id);
}

export function removePendingAttachment(db: Database, store: AttachmentStore, id: string, uploadedBy: string): boolean {
  const row = getAttachment(db, id);
  if (!row || row.uploaded_by !== uploadedBy || row.message_id) return false;
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  store.remove(row.storage_key);
  return true;
}

/** Remove abandoned uploads and bytes left behind by a deleted user/conversation. */
export function pruneAttachments(db: Database, store: AttachmentStore, now = new Date()): number {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attachments'",
  ).get();
  if (!tableExists) return 0;
  const cutoff = new Date(now.getTime() - PENDING_ATTACHMENT_RETENTION_MS).toISOString();
  const stale = db.prepare('SELECT storage_key FROM attachments WHERE message_id IS NULL AND created_at < ?').all(cutoff) as { storage_key: string }[];
  if (stale.length) {
    db.prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?').run(cutoff);
    for (const row of stale) store.remove(row.storage_key);
  }
  const known = new Set((db.prepare('SELECT storage_key FROM attachments').all() as { storage_key: string }[]).map((row) => row.storage_key));
  let removed = stale.length;
  for (const filename of fs.readdirSync(store.directory)) {
    if (!/^[0-9a-f-]{36}\.bin$/.test(filename) || known.has(filename)) continue;
    store.remove(filename);
    removed += 1;
  }
  return removed;
}
