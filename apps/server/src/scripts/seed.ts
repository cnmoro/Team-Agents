/**
 * Creates a small set of demo users and conversations so the UI has something
 * to show on a fresh install. Safe to re-run: existing users are left alone.
 */
import { connectDatabase, disconnectDatabase } from '../db.js';
import { ConversationModel, makeDmKey } from '../models/conversation.js';
import { UserModel, buildSearchKey, pickAvatarColor } from '../models/user.js';
import { hashPassword } from '../services/auth.js';
import { createMessage } from '../services/messageService.js';

const PASSWORD = 'password123';

const PEOPLE = [
  { email: 'ada@teamagents.dev', username: 'ada', firstName: 'Ada', lastName: 'Lovelace' },
  { email: 'alan@teamagents.dev', username: 'alan', firstName: 'Alan', lastName: 'Turing' },
  { email: 'grace@teamagents.dev', username: 'grace', firstName: 'Grace', lastName: 'Hopper' },
  { email: 'linus@teamagents.dev', username: 'linus', firstName: 'Linus', lastName: 'Torvalds' },
  { email: 'margaret@teamagents.dev', username: 'margaret', firstName: 'Margaret', lastName: 'Hamilton' },
];

async function main(): Promise<void> {
  await connectDatabase();

  const passwordHash = await hashPassword(PASSWORD);
  const users = [];

  for (const person of PEOPLE) {
    const existing = await UserModel.findOne({ email: person.email });
    if (existing) {
      users.push(existing);
      continue;
    }
    users.push(
      await UserModel.create({
        ...person,
        passwordHash,
        searchKey: buildSearchKey(person),
        avatarColor: pickAvatarColor(person.username),
      }),
    );
  }

  const [ada, alan, grace, linus, margaret] = users;
  if (!ada || !alan || !grace || !linus || !margaret) throw new Error('seed users missing');

  const now = new Date();

  const dmKey = makeDmKey(String(ada._id), String(alan._id));
  let dm = await ConversationModel.findOne({ dmKey });
  if (!dm) {
    dm = await ConversationModel.create({
      type: 'dm',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      dmKey,
      lastMessageAt: now,
    });
    await createMessage({
      conversationId: String(dm._id),
      kind: 'user',
      authorKind: 'user',
      authorUserId: String(alan._id),
      blocks: [{ type: 'text', text: 'Morning! Did you get a chance to look at the deploy script?' }],
    });
  }

  let group = await ConversationModel.findOne({ type: 'group', name: 'Platform Team' });
  if (!group) {
    group = await ConversationModel.create({
      type: 'group',
      name: 'Platform Team',
      memberIds: [ada._id, alan._id, grace._id, linus._id, margaret._id],
      createdBy: grace._id,
      lastMessageAt: now,
    });
    await createMessage({
      conversationId: String(group._id),
      kind: 'system',
      authorKind: 'system',
      blocks: [{ type: 'text', text: 'Grace created the group "Platform Team".' }],
    });
    await createMessage({
      conversationId: String(group._id),
      kind: 'user',
      authorKind: 'user',
      authorUserId: String(grace._id),
      blocks: [
        { type: 'text', text: 'Here is the migration we discussed:' },
        {
          type: 'code',
          language: 'sql',
          code: 'ALTER TABLE users\n  ADD COLUMN last_seen_at TIMESTAMPTZ;\n\nCREATE INDEX idx_users_last_seen\n  ON users (last_seen_at DESC);',
        },
      ],
    });
    await createMessage({
      conversationId: String(group._id),
      kind: 'user',
      authorKind: 'user',
      authorUserId: String(margaret._id),
      blocks: [{ type: 'text', text: 'Looks right to me. Should we run it before or after the release?' }],
      mentions: [String(grace._id)],
    });
  }

  console.log('\nSeeded users (password for all: %s):\n', PASSWORD);
  for (const person of PEOPLE) console.log(`  ${person.email}  (@${person.username})`);
  console.log('\nConversations: 1 direct message, 1 group ("Platform Team")\n');

  await disconnectDatabase();
}

main().catch((error) => {
  console.error('seed failed:', error);
  process.exit(1);
});
