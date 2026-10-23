import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent, setAgentAvailability } from '../agents/repository.js';
import { createConversation, removeParticipant } from '../conversations/repository.js';
import { createProviderConfig } from '../providers/repository.js';
import { createMessage } from '../messages/repository.js';
import { ConnectionHub } from '../ws/hub.js';
import { createAutomation, getAutomation, listAutomationRuns, runDueSchedules, updateAutomation, type AutomationDeps } from './service.js';
import { isFollowupDaytime } from './proactive.js';
import type { RespondFn } from '../runtime/engine.js';

describe('proactive conversation follow-ups', () => {
  let db: Database;
  let userId: string, agentId: string, conversationId: string, ruleId: string;
  let respond: ReturnType<typeof vi.fn<RespondFn>>;
  let deps: AutomationDeps;
  const at = (date: string) => vi.setSystemTime(new Date(date));
  const tick = () => runDueSchedules(deps, new Date());
  const human = (body = 'I still need to write the launch announcement.') => createMessage(db, {
    conversationId, authorId: userId, authorType: 'user', body, mentions: [], replyToMessageId: null,
  });
  const messages = () => db.prepare('SELECT author_type, body FROM messages WHERE conversation_id = ? ORDER BY rowid').all(conversationId);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); at('2030-01-01T08:00:00Z');
    db = openSqlite(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    userId = createUser(db, { email: 'owner@example.test', displayName: 'Owner', passwordHash: 'x', role: 'owner' }).id;
    createProviderConfig(db, { id: 'test', kind: 'openai-compatible', apiKey: 'fixture' });
    agentId = createAgent(db, { ownerUserId: userId, name: 'Helper', personality: '', modelPolicy: { defaultProviderId: 'test', defaultModel: 'test' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false } }).id;
    conversationId = createConversation(db, { kind: 'dm', name: null, participants: [{ participantId: userId, participantType: 'user' }, { participantId: agentId, participantType: 'agent' }] }).id;
    human();
    ruleId = createAutomation(db, { createdBy: userId, name: 'Proactive follow-ups', triggerType: 'schedule',
      triggerConfig: { kind: 'conversation_schedule', proactive: true, conversationId, agentId, timeZone: 'UTC', runAt: '2030-01-01T10:00:00Z', intervalMinutes: 1440 },
      actions: [{ type: 'invoke_agent', conversationId, agentId, prompt: 'Help finish the launch.' }] }).automation.id;
    respond = vi.fn<RespondFn>().mockResolvedValue({ body: 'Here is a first draft for the launch announcement.' });
    deps = { db, hub: new ConnectionHub(db), respond };
    at('2030-01-01T10:00:00Z');
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });

  it('posts useful work without a synthetic chat prompt, then waits for a new human message', async () => {
    await Promise.all([tick(), tick()]);
    expect(listAutomationRuns(db, ruleId).map(run => run.error)).toEqual([null]);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]![0]).toMatchObject({ proactive: true, optionalReply: true, allowArtifacts: false, proactiveFocus: 'Help finish the launch.' });
    expect(messages()).toEqual([{ author_type: 'user', body: 'I still need to write the launch announcement.' }, { author_type: 'agent', body: 'Here is a first draft for the launch announcement.' }]);
    at('2030-01-02T10:00:00Z'); await tick();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(listAutomationRuns(db, ruleId)[0]).toMatchObject({ status: 'skipped', output: { skipped: 'already_reviewed' } });
    at('2030-01-03T08:00:00Z'); human('Now draft the FAQ.');
    at('2030-01-03T10:00:00Z'); await tick();
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it('stays silent when the model has nothing useful and persists that decision across ticks', async () => {
    respond.mockResolvedValue({ body: '"NO_REPLY".' });
    await tick(); at('2030-01-02T10:00:00Z'); await tick();
    expect(messages()).toHaveLength(1); expect(respond).toHaveBeenCalledTimes(1);
    expect(getAutomation(db, ruleId)?.triggerConfig.checkedMessageId).toBeDefined();
    expect(listAutomationRuns(db, ruleId).every(run => run.status === 'skipped')).toBe(true);
  });

  it.each(['night', 'dnd', 'busy', 'active', 'stale', 'access', 'disabled'] as const)('does not call the model when %s', async reason => {
    if (reason === 'night') at('2030-01-01T23:00:00Z');
    if (reason === 'dnd') setAgentAvailability(db, agentId, 'dnd');
    if (reason === 'busy') db.prepare("INSERT INTO agent_runs (run_id, root_run_id, hop_count, agent_id, conversation_id, created_at, status) VALUES ('busy', 'busy', 0, ?, ?, ?, 'running')").run(agentId, conversationId, new Date().toISOString());
    if (reason === 'active') human('One more thing');
    if (reason === 'stale') at('2030-01-09T10:00:00Z');
    if (reason === 'access') removeParticipant(db, conversationId, userId);
    if (reason === 'disabled') updateAutomation(db, ruleId, { ...getAutomation(db, ruleId)!, enabled: false });
    await tick(); expect(respond).not.toHaveBeenCalled(); expect(messages().filter((message: any) => message.author_type === 'agent')).toHaveLength(0);
  });

  it.each(['new-message', 'pause', 'access', 'dnd'] as const)('discards a late answer after %s and marks the run cancelled', async reason => {
    respond.mockImplementation(async () => {
      if (reason === 'new-message') human('Actually, abandon that topic.');
      if (reason === 'pause') updateAutomation(db, ruleId, { ...getAutomation(db, ruleId)!, enabled: false });
      if (reason === 'access') removeParticipant(db, conversationId, userId);
      if (reason === 'dnd') setAgentAvailability(db, agentId, 'dnd');
      return { body: 'This is now stale.', handoffToAgentId: 'another-agent' };
    });
    await tick();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(messages().filter((message: any) => message.author_type === 'agent')).toHaveLength(0);
    expect(db.prepare("SELECT status FROM agent_runs WHERE trigger = 'proactive'").get()).toEqual({ status: 'cancelled' });
    expect(listAutomationRuns(db, ruleId)[0]).toMatchObject({ status: 'skipped', output: { skipped: 'context_changed' } });
  });

  it('enforces a full 24 hours between model calls even across adjacent schedule slots', async () => {
    at('2030-01-02T09:59:00Z'); await tick();
    human('Please prepare a launch FAQ too.');
    at('2030-01-02T10:30:00Z'); await tick();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(listAutomationRuns(db, ruleId)[0]).toMatchObject({ output: { skipped: 'daily_limit' } });
  });

  it('does not retry a failed paid review on each tick or the following day', async () => {
    respond.mockRejectedValue(new Error('Provider unavailable'));
    await tick(); at('2030-01-02T10:00:00Z'); await tick();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(messages()).toHaveLength(1);
  });

  it('uses the selected time zone, including daylight-saving changes', () => {
    expect(isFollowupDaytime('Europe/Warsaw', new Date('2030-01-01T07:00:00Z'))).toBe(true);
    expect(isFollowupDaytime('Europe/Warsaw', new Date('2030-07-01T06:00:00Z'))).toBe(true);
    expect(isFollowupDaytime('Europe/Warsaw', new Date('2030-07-01T18:00:00Z'))).toBe(false);
    expect(isFollowupDaytime('invalid', new Date())).toBe(false);
  });
});
