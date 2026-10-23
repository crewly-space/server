import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createAgent, setAgentAvailability } from '../agents/repository.js';
import { createUser } from '../users/repository.js';
import { createProviderConfig } from '../providers/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createMessage } from '../messages/repository.js';
import { upsertConversationSummary } from '../memory/summary-repository.js';
import { createAutomation, getAutomation, listAutomationRuns, updateAutomation } from '../automations/service.js';
import { AiGateway } from '../gateway/gateway.js';
import { setDelegates } from './delegation.js';
import { listAgentRunsForRoot, listRunEvents } from './runs.js';

interface RequestBody { system?: string; messages: unknown[]; tools?: Array<{ name: string }> }
const answer = (value: string) => new Response(JSON.stringify({ content: [{ type: 'text', text: value }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
const consult = (...agents: string[]) => new Response(JSON.stringify({
  content: agents.map((agent, i) => ({ type: 'tool_use', id: `consult-${i}`, name: 'delegate_to_agent', input: { agent, task: 'Suggest one way to resolve the launch blocker.' } })),
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 10 },
}));

describe('scheduled proactive agent consultations', () => {
  let db: Database, app: Awaited<ReturnType<typeof buildApp>>;
  let userId: string, lead: string, researcher: string, conversationId: string, ruleId: string;
  let replies: Response[], sent: RequestBody[];
  let onRequest: ((index: number) => void) | undefined;
  const newAgent = (name: string, ownerUserId = userId) => createAgent(db, {
    ownerUserId, name, personality: `${name} expertise`, modelPolicy: { defaultProviderId: 'fixture', defaultModel: 'fixture' },
    permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
  }).id;
  const messages = () => db.prepare('SELECT author_id, body FROM messages WHERE conversation_id = ? ORDER BY rowid').all(conversationId);
  const tree = () => {
    const root = db.prepare("SELECT run_id FROM agent_runs WHERE trigger = 'proactive'").get() as { run_id: string };
    return listAgentRunsForRoot(db, root.run_id);
  };
  async function tick() {
    await vi.advanceTimersByTimeAsync(60000);
    await vi.waitFor(() => expect(listAutomationRuns(db, ruleId)[0]?.status).not.toBe('running'));
    expect(listAutomationRuns(db, ruleId)).toHaveLength(1);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2030-06-01T10:00:00Z'));
    db = openSqlite(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    userId = createUser(db, { email: 'owner@example.test', displayName: 'Owner', passwordHash: 'x', role: 'owner' }).id;
    createProviderConfig(db, { id: 'fixture', kind: 'anthropic', apiKey: 'fixture' });
    lead = newAgent('Lead'); researcher = newAgent('Researcher');
    setDelegates(db, lead, [researcher]);
    conversationId = createConversation(db, { kind: 'dm', name: null, participants: [{ participantId: userId, participantType: 'user' }, { participantId: lead, participantType: 'agent' }] }).id;
    const message = createMessage(db, { conversationId, authorId: userId, authorType: 'user', body: 'Our launch still needs a useful plan.', mentions: [], replyToMessageId: null });
    upsertConversationSummary(db, { conversationId, summary: 'PRIVATE_FULL_CONVERSATION_SUMMARY', upToMessageId: message.id });
    vi.setSystemTime(new Date('2030-06-01T12:00:00Z'));
    ruleId = createAutomation(db, { createdBy: userId, name: 'Follow-ups', triggerType: 'schedule',
      triggerConfig: { kind: 'conversation_schedule', proactive: true, conversationId, agentId: lead, timeZone: 'UTC', runAt: '2030-06-01T12:01:00Z', intervalMinutes: 1440 },
      actions: [{ type: 'invoke_agent', agentId: lead, conversationId, prompt: 'Move the launch forward.' }] }).automation.id;
    replies = []; sent = []; onRequest = undefined;
    const gateway = new AiGateway({ db, sleep: async () => {}, fetchImpl: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body))); onRequest?.(sent.length);
      const response = replies.shift(); if (!response) throw new Error('No scripted response'); return response;
    }) as typeof fetch });
    app = await buildApp({ db, gateway });
  });
  afterEach(async () => { await app.close(); db.close(); vi.useRealTimers(); });

  it('wakes on the real scheduler, consults a teammate and posts one synthesized answer', async () => {
    replies.push(consult('Researcher'), answer('Start with a small pilot.'), answer('Next step: run a small pilot with these acceptance checks.'));
    await tick();
    expect(sent).toHaveLength(3);
    expect(sent[0]!.tools?.map(tool => tool.name)).toEqual(['delegate_to_agent']);
    expect(sent[0]!.system).toContain('PRIVATE_FULL_CONVERSATION_SUMMARY');
    expect(sent[0]!.system).toContain('proactively consult');
    expect(sent[1]!.tools).toBeUndefined();
    expect(sent[1]!.system).toContain('Answer only the scoped task');
    expect(JSON.stringify(sent[1])).not.toContain('PRIVATE_FULL_CONVERSATION_SUMMARY');
    expect(JSON.stringify(sent[1])).not.toContain('Our launch still needs');
    expect(JSON.stringify(sent[1]!.messages)).toContain('Suggest one way');
    expect(messages()).toEqual([{ author_id: userId, body: 'Our launch still needs a useful plan.' }, { author_id: lead, body: 'Next step: run a small pilot with these acceptance checks.' }]);
    expect(tree().map(run => ({ agentId: run.agentId, status: run.status }))).toEqual([{ agentId: lead, status: 'completed' }, { agentId: researcher, status: 'completed' }]);
    expect(listRunEvents(db, tree()[0]!.runId).some(event => event.type === 'delegation.completed')).toBe(true);
    vi.setSystemTime(new Date('2030-06-02T12:01:00Z'));
    await vi.advanceTimersByTimeAsync(60000);
    await vi.waitFor(() => expect(listAutomationRuns(db, ruleId)).toHaveLength(2));
    expect(sent).toHaveLength(3);
  });

  it('enforces two distinct consultations even when the model requests three in a single response', async () => {
    const writer = newAgent('Writer'), critic = newAgent('Critic'); setDelegates(db, lead, [researcher, writer, critic]);
    replies.push(consult('Researcher', 'Writer', 'Critic'), answer('Pilot first.'), answer('Here is a draft.'), answer('The combined plan is ready.'));
    await tick();
    expect(sent).toHaveLength(4); expect(tree()).toHaveLength(3);
    expect(tree().some(run => run.agentId === critic)).toBe(false);
    expect(JSON.stringify(sent[3]!.messages)).toContain('two-teammate consultation limit');
    expect(sent[1]!.tools).toBeUndefined(); expect(sent[2]!.tools).toBeUndefined();
  });

  it('refuses repeated consultations with the same teammate', async () => {
    replies.push(consult('Researcher', 'Researcher'), answer('Pilot first.'), answer('Use the pilot plan.'));
    await tick();
    expect(sent).toHaveLength(3); expect(tree()).toHaveLength(2);
    expect(JSON.stringify(sent[2]!.messages)).toContain('already been consulted');
  });

  it.each(['dnd', 'busy', 'other-owner', 'permission'] as const)('does not consult a teammate when %s', async reason => {
    if (reason === 'dnd') setAgentAvailability(db, researcher, 'dnd');
    if (reason === 'busy') db.prepare("INSERT INTO agent_runs (run_id, root_run_id, hop_count, agent_id, conversation_id, created_at, status) VALUES ('busy', 'busy', 0, ?, ?, ?, 'running')").run(researcher, conversationId, new Date().toISOString());
    if (reason === 'other-owner') {
      const stranger = createUser(db, { email: 'other@example.test', displayName: 'Other', passwordHash: 'x', role: 'member' });
      setDelegates(db, lead, [newAgent('Other assistant', stranger.id)]);
    }
    if (reason === 'permission') db.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ tools: [], canMessageAgents: false, canApproveOwnActions: false }), lead);
    replies.push(answer('A concrete next step without consultation.')); await tick();
    expect(sent).toHaveLength(1); expect(sent[0]!.tools).toBeUndefined(); expect(tree()).toHaveLength(1);
  });

  it('rechecks the delegate list after tool discovery', async () => {
    onRequest = index => { if (index === 1) setDelegates(db, lead, []); };
    replies.push(consult('Researcher'), answer('I can proceed with a draft myself.')); await tick();
    expect(sent).toHaveLength(2); expect(tree()).toHaveLength(1);
    expect(JSON.stringify(sent[1]!.messages)).toContain('Permission to contact this agent was removed');
  });

  it('cancels the consultation and parent answer when paused during the child call', async () => {
    onRequest = index => { if (index === 2) updateAutomation(db, ruleId, { ...getAutomation(db, ruleId)!, enabled: false }); };
    replies.push(consult('Researcher'), answer('This should never be delivered.')); await tick();
    expect(sent).toHaveLength(2); expect(messages()).toHaveLength(1);
    expect(tree().map(run => run.status)).toEqual(['cancelled', 'cancelled']);
    expect(listAutomationRuns(db, ruleId)[0]).toMatchObject({ status: 'skipped', output: { skipped: 'context_changed' } });
  });
});
