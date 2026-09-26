import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { hasPermission } from '../permissions/roles.js';
import { fetchRegistryItems, getRegistrySettings, installRegistryItem, listRegistryInstallations, pinRegistryInstallation, updateRegistrySettings } from './service.js';

const admin = (app: FastifyInstance, userId: string) => hasPermission(app.db, userId, 'integrations.manage');
export function registerRegistryRoutes(app: FastifyInstance, fetchImpl: typeof fetch): void {
  app.get('/api/v1/registry/settings', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    reply.send(getRegistrySettings(app.db));
  });
  app.put('/api/v1/registry/settings', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    const body = z.object({ enabled: z.boolean(), registryUrl: z.string().url().nullable(), allowUnverified: z.boolean().default(false) }).parse(request.body);
    reply.send(updateRegistrySettings(app.db, { ...body, userId: request.user!.id }));
  });
  app.get('/api/v1/registry/items', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    const query = z.object({ q: z.string().max(200).default(''), type: z.enum(['skill','mcp_preset']).optional() }).parse(request.query);
    try { const needle = query.q.toLowerCase(); const items = (await fetchRegistryItems(app.db, fetchImpl)).filter((item) => (!query.type || item.type === query.type) && (!needle || `${item.name} ${item.description} ${item.publisher}`.toLowerCase().includes(needle))); reply.send({ items }); }
    catch (error) { reply.code(503).send({ error: error instanceof Error ? error.message : 'registry_unavailable' }); }
  });
  app.get('/api/v1/registry/installations', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    reply.send({ installations: listRegistryInstallations(app.db) });
  });
  app.post('/api/v1/registry/install', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    const body = z.object({ itemId: z.string().min(1).max(200), type: z.enum(['skill','mcp_preset']), version: z.string().max(40).optional() }).parse(request.body);
    try { const item = (await fetchRegistryItems(app.db, fetchImpl)).find((entry) => entry.id === body.itemId && entry.type === body.type); if (!item) { reply.code(404).send({ error: 'registry_item_not_found' }); return; }
      reply.code(201).send(installRegistryItem(app.db, item, body.version, request.user!.id)); }
    catch (error) { reply.code(400).send({ error: error instanceof Error ? error.message : 'registry_install_failed' }); }
  });
  app.put('/api/v1/registry/installations/:id/pin', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request.user!.id)) { reply.code(403).send({ error: 'integrations_manage_required' }); return; }
    const body = z.object({ version: z.string().max(40).nullable() }).parse(request.body);
    try { pinRegistryInstallation(app.db, (request.params as { id: string }).id, body.version); reply.code(204).send(); }
    catch { reply.code(404).send({ error: 'registry_installation_not_found' }); }
  });
}
