import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase, mongoose } from '../db.js';
import { ConversationModel, makeDmKey } from '../models/conversation.js';
import { MessageModel } from '../models/message.js';
import { UserModel, buildSearchKey, pickAvatarColor } from '../models/user.js';
import { buildSummaries, computeUnread, previewFromBlocks } from './conversationService.js';

/**
 * Runs against a real MongoDB, on its own database.
 *
 * Unread state is derived from timestamps rather than a counter, and the point
 * of these tests is to prove that derivation is right — including the cases a
 * counter would get wrong, such as a client that never acknowledged a message.
 */
const TEST_URI =
  process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017/teamagents_unit_test';

async function makeUser(username: string) {
  return UserModel.create({
    email: `${username}@test.local`,
    username,
    firstName: username,
    lastName: 'Test',
    passwordHash: 'x',
    searchKey: buildSearchKey({
      firstName: username,
      lastName: 'Test',
      email: `${username}@test.local`,
      username,
    }),
    avatarColor: pickAvatarColor(username),
  });
}

async function postMessage(
  conversationId: Types.ObjectId,
  authorId: Types.ObjectId | null,
  text: string,
  mentions: Types.ObjectId[] = [],
) {
  return MessageModel.create({
    conversationId,
    kind: authorId ? 'user' : 'system',
    authorKind: authorId ? 'user' : 'system',
    authorUserId: authorId,
    blocks: [{ type: 'text', text }],
    mentions,
  });
}

describe('conversation unread state', () => {
  beforeAll(async () => {
    await connectDatabase(TEST_URI);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
    ]);
  });

  it('counts messages from others and ignores your own', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const conversation = await ConversationModel.create({
      type: 'dm',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      dmKey: makeDmKey(String(ada._id), String(alan._id)),
      lastMessageAt: new Date(),
    });

    await postMessage(conversation._id, alan._id, 'one');
    await postMessage(conversation._id, alan._id, 'two');
    await postMessage(conversation._id, ada._id, 'my own reply');

    const unread = await computeUnread([conversation], String(ada._id));
    expect(unread.get(String(conversation._id))?.unreadCount).toBe(2);

    const forAlan = await computeUnread([conversation], String(alan._id));
    expect(forAlan.get(String(conversation._id))?.unreadCount).toBe(1);
  });

  it('counts only messages newer than the read marker', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const conversation = await ConversationModel.create({
      type: 'dm',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      dmKey: makeDmKey(String(ada._id), String(alan._id)),
      lastMessageAt: new Date(),
    });

    await postMessage(conversation._id, alan._id, 'before');
    // Reading everything up to now.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const readAt = new Date();
    conversation.lastReadAt.set(String(ada._id), readAt);
    await conversation.save();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await postMessage(conversation._id, alan._id, 'after');

    const fresh = await ConversationModel.findById(conversation._id);
    const unread = await computeUnread([fresh!], String(ada._id));
    expect(unread.get(String(conversation._id))?.unreadCount).toBe(1);
  });

  it('flags a mention separately from the count', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const conversation = await ConversationModel.create({
      type: 'group',
      name: 'Team',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      lastMessageAt: new Date(),
    });

    await postMessage(conversation._id, alan._id, 'nothing for you');
    let unread = await computeUnread([conversation], String(ada._id));
    expect(unread.get(String(conversation._id))?.hasMention).toBe(false);

    await postMessage(conversation._id, alan._id, 'hey you', [ada._id]);
    unread = await computeUnread([conversation], String(ada._id));
    expect(unread.get(String(conversation._id))?.hasMention).toBe(true);
    expect(unread.get(String(conversation._id))?.unreadCount).toBe(2);
  });

  it('counts system and agent messages as unread', async () => {
    const ada = await makeUser('ada');
    const conversation = await ConversationModel.create({
      type: 'group',
      name: 'Team',
      memberIds: [ada._id],
      createdBy: ada._id,
      lastMessageAt: new Date(),
    });
    // An agent's answer should light up the sidebar just like a person's.
    await postMessage(conversation._id, null, 'the agent finished');

    const unread = await computeUnread([conversation], String(ada._id));
    expect(unread.get(String(conversation._id))?.unreadCount).toBe(1);
  });

  it('computes several conversations in one pass, each with its own marker', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');

    const first = await ConversationModel.create({
      type: 'group',
      name: 'First',
      memberIds: [ada._id, alan._id],
      createdBy: alan._id,
      lastMessageAt: new Date(),
    });
    const second = await ConversationModel.create({
      type: 'group',
      name: 'Second',
      memberIds: [ada._id, alan._id],
      createdBy: alan._id,
      lastMessageAt: new Date(),
    });

    await postMessage(first._id, alan._id, 'a');
    await postMessage(first._id, alan._id, 'b');
    await postMessage(second._id, alan._id, 'c');

    // Ada has read everything in the second conversation only.
    second.lastReadAt.set(String(ada._id), new Date());
    await second.save();

    const unread = await computeUnread(
      [first, (await ConversationModel.findById(second._id))!],
      String(ada._id),
    );
    expect(unread.get(String(first._id))?.unreadCount).toBe(2);
    expect(unread.get(String(second._id))?.unreadCount).toBe(0);
  });

  it('resolves per-viewer titles for DMs and groups', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const dm = await ConversationModel.create({
      type: 'dm',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      dmKey: makeDmKey(String(ada._id), String(alan._id)),
      lastMessageAt: new Date(),
    });
    const group = await ConversationModel.create({
      type: 'group',
      name: 'Platform',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      lastMessageAt: new Date(),
    });

    const [adaDm, adaGroup] = await buildSummaries([dm, group], String(ada._id));
    // A DM is titled by the other person, so each side sees a different name.
    expect(adaDm!.title).toBe('alan Test');
    expect(adaGroup!.title).toBe('Platform');

    const [alanDm] = await buildSummaries([dm], String(alan._id));
    expect(alanDm!.title).toBe('ada Test');
  });

  it('returns nothing for an empty input', async () => {
    expect((await computeUnread([], 'anyone')).size).toBe(0);
    expect(await buildSummaries([], 'anyone')).toEqual([]);
  });
});

describe('previewFromBlocks', () => {
  it('describes each block type', () => {
    expect(previewFromBlocks([{ type: 'text', text: 'hello' }])).toBe('hello');
    expect(previewFromBlocks([{ type: 'code', language: 'sql', code: 'SELECT 1' }])).toBe(
      '[sql snippet]',
    );
    expect(
      previewFromBlocks([
        { type: 'image', fileId: 'a', filename: 'x.png', mimeType: 'image/png', size: 1 },
      ]),
    ).toBe('[image]');
    expect(
      previewFromBlocks([
        { type: 'file', fileId: 'a', filename: 'report.pdf', mimeType: 'application/pdf', size: 1 },
      ]),
    ).toBe('[report.pdf]');
  });

  it('prefixes the author when given', () => {
    expect(previewFromBlocks([{ type: 'text', text: 'hi' }], 'Ada')).toBe('Ada: hi');
  });

  it('collapses whitespace and truncates', () => {
    const preview = previewFromBlocks([{ type: 'text', text: `a${'b'.repeat(400)}` }]);
    expect(preview.length).toBeLessThanOrEqual(180);
    expect(previewFromBlocks([{ type: 'text', text: 'a\n\n   b' }])).toBe('a b');
  });
});
