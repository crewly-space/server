import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { ConnectionHub } from './hub.js';

function fakeSocket() {
  return {
    readyState: 1,
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

describe('ConnectionHub', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshHub() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-hub-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    return { db, hub: new ConnectionHub(db) };
  }

  it('persists an event to event_log even with no subscribers', () => {
    const { db, hub } = freshHub();
    const event = hub.publish('user:user_1', 'user.updated', { id: 'user_1' });
    const row = db.prepare('SELECT * FROM event_log WHERE seq = ?').get(event.seq) as
      | { topic: string }
      | undefined;
    expect(row?.topic).toBe('user:user_1');
    db.close();
  });

  it('broadcasts only to sockets subscribed to the matching topic', () => {
    const { db, hub } = freshHub();
    const subscribed = fakeSocket();
    const notSubscribed = fakeSocket();
    hub.subscribe(subscribed, ['user:user_1']);
    hub.subscribe(notSubscribed, ['user:user_2']);

    hub.publish('user:user_1', 'user.updated', { id: 'user_1' });

    expect(subscribed.send).toHaveBeenCalledTimes(1);
    expect(notSubscribed.send).not.toHaveBeenCalled();
    db.close();
  });

  it('replays only events after sinceSeq for the requested topics', () => {
    const { db, hub } = freshHub();
    const first = hub.publish('user:user_1', 'user.updated', { n: 1 });
    hub.publish('user:user_1', 'user.updated', { n: 2 });
    hub.publish('user:user_2', 'user.updated', { n: 3 });

    const replayed = hub.replaySince(['user:user_1'], first.seq);
    expect(replayed).toHaveLength(1);
    expect((replayed[0].payload as { n: number }).n).toBe(2);
    db.close();
  });

  it('adds and drops a topic on the sockets someone already has open', () => {
    const { db, hub } = freshHub();
    const mine = fakeSocket();
    const theirs = fakeSocket();
    hub.subscribe(mine, ['user:a'], 'a');
    hub.subscribe(theirs, ['user:b'], 'b');

    hub.addUserTopic('a', 'conversation:c1');
    hub.publish('conversation:c1', 'message.created', { id: 'm1' });
    expect(mine.send).toHaveBeenCalledTimes(1);
    expect(theirs.send).not.toHaveBeenCalled();

    hub.removeUserTopic('a', 'conversation:c1');
    hub.publish('conversation:c1', 'message.created', { id: 'm2' });
    expect(mine.send).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('closes and unsubscribes revoked sessions before sending an event', () => {
    const { db, hub } = freshHub();
    const socket = fakeSocket();
    const authorize = vi.fn().mockReturnValue(false);
    hub.subscribe(socket, ['user:a'], 'a', authorize);
    hub.publish('user:a', 'user.updated', {});
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(4001, 'unauthorized');
    hub.revalidateSessions();
    expect(authorize).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('revalidates idle sessions without disconnecting valid ones', () => {
    const { db, hub } = freshHub();
    const valid = fakeSocket();
    const expired = fakeSocket();
    hub.subscribe(valid, ['user:a'], 'a', () => true);
    hub.subscribe(expired, ['user:b'], 'b', () => false);
    hub.revalidateSessions();
    expect(valid.close).not.toHaveBeenCalled();
    expect(expired.close).toHaveBeenCalledWith(4001, 'unauthorized');
    db.close();
  });
});
