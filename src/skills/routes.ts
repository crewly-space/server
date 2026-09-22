import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getAgent } from '../agents/repository.js';
import {
  createSkill,
  deleteSkill,
  getSkill,
  listAgentSkills,
  listSkills,
  parseSkillManifest,
  setAgentSkills,
  SkillExistsError,
  SkillValidationError,
  updateSkill,
  validateSkillConfig,
} from './skills.js';

const FieldSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  label: z.string().min(1).max(100),
  secret: z.boolean().default(false),
  required: z.boolean().default(false),
});

const SkillBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().min(1).max(20_000),
  configFields: z.array(FieldSchema).max(30).optional(),
  version: z.string().max(40).optional(),
});

const InstallBodySchema = z.object({
  manifest: z.string().min(1).max(40_000),
  /** Where the manifest came from, kept so a registry can offer updates later. */
  sourceRef: z.string().max(2048).optional(),
});

const AgentSkillsSchema = z.object({
  skills: z.array(z.object({
    skillId: z.string().min(1),
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.string().max(4096)).default({}),
  })).max(50),
});

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.user!.role === 'owner' || request.user!.role === 'admin') return true;
  reply.code(403).send({ error: 'forbidden' });
  return false;
}

/**
 * Skills are a server's shared library: admins add them, anyone can read
 * them, and an agent's owner chooses which ones their agent uses.
 */
export function registerSkillRoutes(app: FastifyInstance): void {
  app.get('/api/v1/skills', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send({ skills: listSkills(app.db) });
  });

  app.post('/api/v1/skills', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      reply.code(201).send(createSkill(app.db, { ...SkillBodySchema.parse(request.body), source: 'custom' }, request.user!.id));
    } catch (error) {
      if (error instanceof SkillExistsError) return reply.code(409).send({ error: 'skill_exists', message: error.message });
      throw error;
    }
  });

  /** Installs a skill from a manifest (frontmatter + instructions), the format a registry would serve. */
  app.post('/api/v1/skills/install', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = InstallBodySchema.parse(request.body);
    try {
      const parsed = parseSkillManifest(body.manifest);
      const validated = SkillBodySchema.parse(parsed);
      reply.code(201).send(createSkill(app.db, { ...validated, source: 'installed', sourceRef: body.sourceRef ?? null }, request.user!.id));
    } catch (error) {
      if (error instanceof SkillExistsError) return reply.code(409).send({ error: 'skill_exists', message: error.message });
      if (error instanceof SkillValidationError) return reply.code(400).send({ error: 'invalid_manifest', message: error.message });
      throw error;
    }
  });

  app.patch('/api/v1/skills/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const skill = updateSkill(app.db, id, SkillBodySchema.partial().omit({ slug: true }).parse(request.body));
    if (!skill) return reply.code(404).send({ error: 'skill_not_found' });
    reply.send(skill);
  });

  app.delete('/api/v1/skills/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!deleteSkill(app.db, id)) return reply.code(404).send({ error: 'skill_not_found' });
    reply.code(204).send();
  });

  app.get('/api/v1/agents/:id/skills', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getAgent(app.db, id)) return reply.code(404).send({ error: 'agent_not_found' });
    reply.send({ skills: listAgentSkills(app.db, id) });
  });

  app.put('/api/v1/agents/:id/skills', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = getAgent(app.db, id);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    const role = request.user!.role;
    if (agent.ownerUserId !== request.user!.id && role !== 'owner' && role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = AgentSkillsSchema.parse(request.body);
    for (const entry of body.skills) {
      const skill = getSkill(app.db, entry.skillId);
      if (!skill) return reply.code(400).send({ error: 'skill_not_found', skillId: entry.skillId });
      try {
        validateSkillConfig(skill, entry.config);
      } catch (error) {
        if (error instanceof SkillValidationError) {
          return reply.code(400).send({ error: 'invalid_skill_config', skill: skill.name, message: error.message });
        }
        throw error;
      }
    }
    setAgentSkills(app.db, id, body.skills);
    reply.send({ skills: listAgentSkills(app.db, id) });
  });
}
