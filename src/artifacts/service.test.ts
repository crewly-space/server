import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createAgentRun } from '../runtime/runs.js';
import { AttachmentStore } from '../attachments/service.js';
import { artifactToolset } from './service.js';
import type { Message } from '../protocol/index.js';

describe('agent artifacts', () => {
  let db: Database;
  let directory: string;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-artifacts-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('only exposes deliberate artifact publication for a top-level run', async () => {
    const owner = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    const agent = createAgent(db, {
      ownerUserId: owner.id,
      name: 'Writer',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    const conversation = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [{ participantId: owner.id, participantType: 'user' }, { participantId: agent.id, participantType: 'agent' }],
    });
    createAgentRun(db, {
      runId: 'run-1', rootRunId: 'run-1', causationId: null, hopCount: 0,
      agentId: agent.id, conversationId: conversation.id,
    });
    const provider = artifactToolset({ db, store: new AttachmentStore(directory) });
    const input = {
      agentId: agent.id,
      conversationId: conversation.id,
      recentMessages: [] as Message[],
      run: { runId: 'run-1', rootRunId: 'run-1', hopCount: 0 },
      allowArtifacts: true,
    };
    const toolset = await provider(agent, input);
    expect(toolset?.definitions[0]?.name).toBe('create_artifact');
    const result = await toolset!.execute({
      id: 'tool-1',
      name: 'create_artifact',
      input: { filename: 'summary.txt', mimeType: 'text/plain', dataBase64: Buffer.from('summary').toString('base64') },
    });
    expect(result.isError).toBeFalsy();
    expect(result.artifactId).toBeTruthy();
    expect(db.prepare('SELECT run_id, agent_id FROM artifacts WHERE attachment_id = ?').get(result.artifactId)).toMatchObject({ run_id: 'run-1', agent_id: agent.id });
    expect(await provider(agent, { ...input, allowArtifacts: false })).toBeUndefined();
  });
});
