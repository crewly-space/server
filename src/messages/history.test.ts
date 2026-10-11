import { afterEach, beforeEach, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createChannel } from '../channels/repository.js';
import { createMessage, listMessagesForConversation, searchMessages } from './repository.js';

let db: Database;
beforeEach(() => { db = openSqlite(':memory:'); runMigrations(db); });
afterEach(() => db.close());
const user = (name: string) => createUser(db, { email: `${name}@example.com`, displayName: name, passwordHash: 'x', role: 'member' });
const post = (conversationId: string, authorId: string, body: string) => createMessage(db, { conversationId, authorId, authorType: 'user', body, mentions: [], replyToMessageId: null });

it('paginates beyond 200 messages without omissions or duplicates and scopes the cursor to its conversation', () => {
  const alice = user('alice'); const bob = user('bob');
  const conversation = createConversation(db, { kind: 'dm', name: null, participants: [{ participantId: alice.id, participantType: 'user' }, { participantId: bob.id, participantType: 'user' }] });
  const sent = Array.from({ length: 225 }, (_, index) => post(conversation.id, alice.id, `message ${index}`));
  const latest = listMessagesForConversation(db, conversation.id, 200, alice.id);
  const earlier = listMessagesForConversation(db, conversation.id, 200, alice.id, latest[0]!.id);
  expect([...earlier, ...latest].map((message) => message.id)).toEqual(sent.map((message) => message.id));
  const other = createConversation(db, { kind: 'group', name: 'Other', participants: [{ participantId: alice.id, participantType: 'user' }, { participantId: bob.id, participantType: 'user' }] });
  expect(listMessagesForConversation(db, other.id, 200, alice.id, latest[0]!.id)).toEqual([]);
});

it('searches public channel history without membership while excluding private channels and other DMs', () => {
  const alice = user('alice'); const bob = user('bob'); const cara = user('cara');
  const channel = (visibility: 'public' | 'private') => createChannel(db, { name: `${visibility}-search`, topic: null, visibility, postRole: 'member', categoryId: null, createdBy: alice.id, members: [{ participantId: alice.id, participantType: 'user' }] }, { id: alice.id, role: 'member' });
  const publicChannel = channel('public'); const privateChannel = channel('private');
  const publicMessage = post(publicChannel.id, alice.id, 'LAUNCH budget is 100%_done');
  post(privateChannel.id, alice.id, 'launch secret');
  const privateDm = createConversation(db, { kind: 'dm', name: null, participants: [{ participantId: alice.id, participantType: 'user' }, { participantId: cara.id, participantType: 'user' }] });
  post(privateDm.id, alice.id, 'launch private DM');
  expect(searchMessages(db, 'launch', bob.id).map((message) => message.id)).toEqual([publicMessage.id]);
  expect(searchMessages(db, '100%_', bob.id).map((message) => message.id)).toEqual([publicMessage.id]);
  expect(searchMessages(db, '100%_wrong', bob.id)).toEqual([]);
});
