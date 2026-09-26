import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { channelNameTaken, createChannel, listChannels } from '../channels/repository.js';
import { createMessage } from '../messages/repository.js';
import { createInvite, findPendingInviteFor } from '../users/invites.js';
import { connectorTokenForImport } from './service.js';
import { slackRequest } from './providers.js';

export interface SlackChannelPreview { id: string; name: string; topic: string; isPrivate: boolean; }

function slackItems<T>(body: Record<string, unknown>, key: string): T[] {
  if (body.ok !== true) throw new Error(`slack_${String(body.error ?? 'request_failed')}`);
  return Array.isArray(body[key]) ? body[key] as T[] : [];
}

export async function previewSlackChannels(db: Database, connectorId: string, fetchImpl: typeof fetch): Promise<SlackChannelPreview[]> {
  const credential = connectorTokenForImport(db, connectorId);
  if (credential.provider !== 'slack') throw new Error('connector_not_slack');
  const response = await slackRequest(credential.token, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 }, fetchImpl);
  return slackItems<Record<string, unknown>>(response.body, 'channels').map((channel) => ({
    id: String(channel.id), name: String(channel.name),
    topic: String((channel.topic as { value?: string } | undefined)?.value ?? ''),
    isPrivate: Boolean(channel.is_private),
  }));
}

export async function importSlackQuickStart(
  db: Database,
  input: { connectorId: string; channelIds: string[]; historyLimit: number; importMembers: boolean; requestedBy: string; role: 'owner' | 'admin' },
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const credential = connectorTokenForImport(db, input.connectorId);
  if (credential.provider !== 'slack') throw new Error('connector_not_slack');
  const id = randomUUID(); const now = new Date().toISOString();
  db.prepare(`INSERT INTO slack_imports (id, connector_id, requested_by, status, options, created_at, updated_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(id, input.connectorId, input.requestedBy, JSON.stringify({ channelIds: input.channelIds, historyLimit: input.historyLimit, importMembers: input.importMembers }), now, now);
  const preview = await previewSlackChannels(db, input.connectorId, fetchImpl);
  const chosen = preview.filter((channel) => input.channelIds.includes(channel.id));
  const summary = { importId: id, createdChannels: 0, matchedChannels: 0, importedMessages: 0, invitedMembers: 0, skipped: 0, failed: [] as string[] };
  for (const remote of chosen) {
    try {
      const mapped = db.prepare(`SELECT local_id FROM slack_import_mappings WHERE connector_id = ? AND remote_type = 'channel' AND remote_id = ?`).pluck().get(input.connectorId, remote.id) as string | undefined;
      let localId = mapped;
      if (!localId) {
        const existing = listChannels(db, { id: input.requestedBy, role: input.role }).find((channel) => channel.name.toLowerCase() === remote.name.toLowerCase());
        if (existing) { localId = existing.id; summary.matchedChannels += 1; }
        else {
          const name = channelNameTaken(db, remote.name) ? `${remote.name}-slack` : remote.name;
          localId = createChannel(db, { name, topic: remote.topic || null, visibility: remote.isPrivate ? 'private' : 'public', postRole: 'member', categoryId: null,
            createdBy: input.requestedBy, members: [{ participantId: input.requestedBy, participantType: 'user' }] }, { id: input.requestedBy, role: input.role }).id;
          summary.createdChannels += 1;
        }
        db.prepare(`INSERT INTO slack_import_mappings (connector_id, remote_type, remote_id, local_id, outcome, updated_at)
          VALUES (?, 'channel', ?, ?, ?, ?) ON CONFLICT(connector_id, remote_type, remote_id) DO UPDATE SET local_id=excluded.local_id, outcome=excluded.outcome, updated_at=excluded.updated_at`)
          .run(input.connectorId, remote.id, localId, existing ? 'matched' : 'created', new Date().toISOString());
      } else summary.matchedChannels += 1;
      if (input.historyLimit > 0) {
        const history = await slackRequest(credential.token, 'conversations.history', { channel: remote.id, limit: Math.min(input.historyLimit, 100) }, fetchImpl);
        for (const message of slackItems<Record<string, unknown>>(history.body, 'messages').reverse()) {
          const remoteId = String(message.ts ?? ''); if (!remoteId) continue;
          if (db.prepare(`SELECT 1 FROM slack_import_mappings WHERE connector_id = ? AND remote_type = 'message' AND remote_id = ?`).get(input.connectorId, remoteId)) { summary.skipped += 1; continue; }
          const created = createMessage(db, { conversationId: localId, authorId: `slack:${String(message.user ?? 'unknown')}`, authorType: 'integration', body: String(message.text ?? ''), mentions: [], replyToMessageId: null });
          db.prepare(`INSERT INTO slack_import_mappings (connector_id, remote_type, remote_id, local_id, outcome, updated_at) VALUES (?, 'message', ?, ?, 'created', ?)`)
            .run(input.connectorId, remoteId, created.id, new Date().toISOString()); summary.importedMessages += 1;
        }
      }
    } catch (error) { summary.failed.push(`${remote.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (input.importMembers) {
    const users = await slackRequest(credential.token, 'users.list', { limit: 200 }, fetchImpl);
    for (const member of slackItems<Record<string, unknown>>(users.body, 'members')) {
      const email = String((member.profile as { email?: string } | undefined)?.email ?? '').trim().toLowerCase();
      if (!email || member.deleted || member.is_bot) { summary.skipped += 1; continue; }
      if (!findPendingInviteFor(db, email)) { createInvite(db, { role: 'member', createdBy: input.requestedBy, email, label: 'Imported from Slack' }); summary.invitedMembers += 1; }
    }
  }
  const status = summary.failed.length ? 'completed_with_errors' : 'completed';
  db.prepare('UPDATE slack_imports SET status = ?, summary = ?, updated_at = ? WHERE id = ?').run(status, JSON.stringify(summary), new Date().toISOString(), id);
  return { ...summary, status };
}
