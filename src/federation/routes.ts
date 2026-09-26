import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { hasPermission } from '../permissions/roles.js';
import { PROTOCOL_VERSION } from '../protocol/index.js';
import { FEDERATION_SCOPE, acceptFederationConnection, confirmFederationConnection, createFederationInvitation, federationSettings, federationSignature, getFederationConnection, listFederationConnections, listFederationEvents, receiveFederationEvent, receiveFederationInvitation, revokeFederationConnection, updateFederationSettings, verifyFederationSignature } from './service.js';

const Scopes = z.array(z.string().regex(FEDERATION_SCOPE)).min(1).max(50).transform((value) => [...new Set(value)]);
const admin = (app: FastifyInstance, userId: string) => hasPermission(app.db, userId, 'integrations.manage');

export function registerFederationRoutes(app: FastifyInstance, options: { publicUrl?: string; fetchImpl: typeof fetch }): void {
  app.get('/api/v1/federation', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    reply.send({ settings: federationSettings(app.db), connections: listFederationConnections(app.db) });
  });
  app.put('/api/v1/federation/settings', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    const body = z.object({ enabled: z.boolean(), displayName: z.string().trim().min(1).max(80) }).parse(request.body);
    reply.send(updateFederationSettings(app.db, body));
  });
  app.post('/api/v1/federation/connections', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    if (!options.publicUrl) { reply.code(503).send({ error: 'public_url_required' }); return; }
    const body = z.object({ remoteUrl: z.string().url(), scopes: Scopes }).parse(request.body);
    const pending = createFederationInvitation(app.db, { ...body, createdBy: request.user!.id });
    const response = await options.fetchImpl(new URL('/api/v1/federation/invitations', body.remoteUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...pending.invitation, originUrl: options.publicUrl, protocolVersion: PROTOCOL_VERSION }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { reply.code(502).send({ error: 'remote_invitation_failed' }); return; }
    reply.code(201).send(pending.connection);
  });
  app.post('/api/v1/federation/invitations', async (request, reply) => {
    const body = z.object({ connectionId: z.string().uuid(), originUrl: z.string().url(), serverId: z.string().uuid(), serverName: z.string().min(1).max(80), scopes: Scopes,
      secret: z.string().min(32).max(200), protocolVersion: z.string() }).parse(request.body);
    if (body.protocolVersion !== PROTOCOL_VERSION) { reply.code(409).send({ error: 'protocol_incompatible', protocolVersion: PROTOCOL_VERSION }); return; }
    // The remote admin still has to accept this pending invitation locally.
    reply.code(201).send(receiveFederationInvitation(app.db, { ...body, originConnectionId: body.connectionId, createdBy: null }));
  });
  app.post('/api/v1/federation/connections/:id/accept', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    if (!options.publicUrl) { reply.code(503).send({ error: 'public_url_required' }); return; }
    const accepted = acceptFederationConnection(app.db, (request.params as { id: string }).id); const settings = federationSettings(app.db);
    const event = (app.db.prepare(`SELECT payload FROM federation_events WHERE connection_id = ? AND event_type = 'connection.invited' ORDER BY created_at DESC LIMIT 1`).pluck().get(accepted.connection.id) as string | undefined);
    const originConnectionId = event ? String((JSON.parse(event) as { originConnectionId: string }).originConnectionId) : '';
    const payload = JSON.stringify({ remoteServerId: settings.serverId, remoteConnectionId: accepted.connection.id, remoteName: settings.displayName }); const timestamp = new Date().toISOString();
    const signature = federationSignature(app.db, accepted.connection.id, timestamp, payload);
    const response = await options.fetchImpl(new URL(`/api/v1/federation/connections/${originConnectionId}/confirm`, accepted.connection.remoteUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-crewly-federation-time': timestamp, 'x-crewly-federation-signature': signature }, body: payload, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { reply.code(502).send({ error: 'remote_confirmation_failed' }); return; }
    reply.send(accepted.connection);
  });
  app.post('/api/v1/federation/connections/:id/confirm', async (request, reply) => {
    const id = (request.params as { id: string }).id; const raw = JSON.stringify(request.body ?? {});
    try { verifyFederationSignature(app.db, id, String(request.headers['x-crewly-federation-time'] ?? ''), raw, String(request.headers['x-crewly-federation-signature'] ?? '')); }
    catch { reply.code(401).send({ error: 'invalid_federation_signature' }); return; }
    const body = z.object({ remoteServerId: z.string().uuid(), remoteConnectionId: z.string().uuid(), remoteName: z.string().min(1).max(80) }).parse(request.body);
    reply.send(confirmFederationConnection(app.db, id, body));
  });
  app.post('/api/v1/federation/connections/:id/events', async (request, reply) => {
    const id = (request.params as { id: string }).id; const raw = JSON.stringify(request.body ?? {});
    let connection; try { connection = verifyFederationSignature(app.db, id, String(request.headers['x-crewly-federation-time'] ?? ''), raw, String(request.headers['x-crewly-federation-signature'] ?? '')); }
    catch { reply.code(401).send({ error: 'invalid_federation_signature' }); return; }
    if (connection.status !== 'active') { reply.code(409).send({ error: 'federation_connection_inactive' }); return; }
    const body = z.object({ id: z.string().uuid(), originServerId: z.string().uuid(), causationId: z.string().optional(), type: z.string().min(1).max(100), scope: z.string().regex(FEDERATION_SCOPE), hopCount: z.number().int().min(0).max(10), payload: z.record(z.string(), z.unknown()) }).parse(request.body);
    reply.send(receiveFederationEvent(app.db, connection, body));
  });
  app.post('/api/v1/federation/connections/:id/events/send', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    const id = (request.params as { id: string }).id; const connection = getFederationConnection(app.db, id);
    if (!connection || connection.status !== 'active') { reply.code(409).send({ error: 'federation_connection_inactive' }); return; }
    const body = z.object({ type: z.string().min(1).max(100), scope: z.string().regex(FEDERATION_SCOPE), causationId: z.string().optional(), hopCount: z.number().int().min(0).max(3).default(0), payload: z.record(z.string(), z.unknown()) }).parse(request.body);
    if (!connection.scopes.includes(body.scope)) { reply.code(403).send({ error: 'federation_scope_denied' }); return; }
    const settings = federationSettings(app.db); const event = { id: randomUUID(), originServerId: settings.serverId, ...body };
    const raw = JSON.stringify(event); const timestamp = new Date().toISOString(); const signature = federationSignature(app.db, id, timestamp, raw);
    if (!connection.remoteConnectionId) { reply.code(409).send({ error: 'remote_connection_id_missing' }); return; }
    const response = await options.fetchImpl(new URL(`/api/v1/federation/connections/${connection.remoteConnectionId}/events`, connection.remoteUrl), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crewly-federation-time': timestamp, 'x-crewly-federation-signature': signature }, body: raw, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    app.db.prepare(`INSERT INTO federation_events (id, connection_id, origin_server_id, causation_id, event_type, scope, direction, hop_count, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?)`)
      .run(event.id, id, settings.serverId, event.causationId ?? null, event.type, event.scope, event.hopCount, JSON.stringify(event.payload), response.ok ? 'delivered' : 'failed', timestamp);
    if (!response.ok) { reply.code(502).send({ error: 'federation_delivery_failed' }); return; }
    reply.code(202).send({ eventId: event.id });
  });
  app.delete('/api/v1/federation/connections/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    const result = revokeFederationConnection(app.db, (request.params as { id: string }).id); if (!result) { reply.code(404).send({ error: 'connection_not_found' }); return; } reply.send(result);
  });
  app.get('/api/v1/federation/connections/:id/events', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    const id = (request.params as { id: string }).id; if (!getFederationConnection(app.db, id)) { reply.code(404).send({ error: 'connection_not_found' }); return; }
    reply.send({ events: listFederationEvents(app.db, id) });
  });
}
