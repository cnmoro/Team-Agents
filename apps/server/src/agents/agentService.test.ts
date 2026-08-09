import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase, mongoose } from '../db.js';
import { ConversationModel, makeDmKey } from '../models/conversation.js';
import { MessageModel } from '../models/message.js';
import { UserModel, buildSearchKey, pickAvatarColor } from '../models/user.js';
import { buildContextTranscript } from './agentService.js';

/**
 * Runs against a real MongoDB, on its own database.
 *
 * `buildContextTranscript` is what "select these messages and send them to
 * the agent" actually threads to the harness's own prompt — it must read
 * exactly like something a human would type, or the LLM ends up parroting
 * wire-format markup back to a user in its reply.
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

describe('buildContextTranscript', () => {
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

  it('renders mentions as plain @Name instead of leaking the wire markup to the agent', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const conversation = await ConversationModel.create({
      type: 'dm',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      dmKey: makeDmKey(String(ada._id), String(alan._id)),
      lastMessageAt: new Date(),
    });

    const message = await MessageModel.create({
      conversationId: conversation._id,
      kind: 'user',
      authorKind: 'user',
      authorUserId: ada._id,
      blocks: [
        {
          type: 'text',
          text: `@[Alan Turing](${String(alan._id)}) can you check this?`,
        },
      ],
      mentions: [alan._id],
    });

    const transcript = await buildContextTranscript(String(conversation._id), [
      String(message._id),
    ]);

    expect(transcript).toContain('@Alan Turing can you check this?');
    expect(transcript).not.toContain('@[Alan Turing]');
    expect(transcript).not.toContain(String(alan._id));
  });

  it('returns an empty string for no message ids', async () => {
    expect(await buildContextTranscript(String(new Types.ObjectId()), [])).toBe('');
  });
});
