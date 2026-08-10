import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase, mongoose } from '../db.js';
import { ConversationModel, makeDmKey } from '../models/conversation.js';
import { AgentSessionModel } from '../models/agentSession.js';
import { UserModel, buildSearchKey, pickAvatarColor } from '../models/user.js';
import { runtime } from './runtime.js';

/**
 * Runs against a real MongoDB, on its own database.
 *
 * Regression guard, 22nd QA pass: closing an agent session ("Close & erase")
 * is supposed to be terminal — the sandbox is gone and the settings panel
 * tells the user that's permanent. But provisioning and a harness turn both
 * run in the background after the HTTP request that started them returns,
 * and their own error handling calls `runtime.setStatus(session, 'error', …)`
 * on whatever session object they're holding. Confirmed live via the real
 * API in this pass: closing 21 sessions immediately after starting them left
 * several back in `error` status with `closedAt` still set — the sandbox had
 * really been erased, but the session no longer showed up as closed anywhere
 * in the UI, with no way to tell what had happened to it.
 */
const TEST_URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017/teamagents_unit_test';

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

describe('runtime.setStatus', () => {
  beforeAll(async () => {
    await connectDatabase(TEST_URI);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await Promise.all([UserModel.deleteMany({}), ConversationModel.deleteMany({}), AgentSessionModel.deleteMany({})]);
  });

  it('cannot resurrect a session that was already closed, even with a stale in-memory copy', async () => {
    const user = await makeUser('ada');
    const conversation = await ConversationModel.create({
      type: 'dm',
      memberIds: [user._id],
      createdBy: user._id,
      dmKey: makeDmKey(String(user._id), String(new Types.ObjectId())),
    });

    const session = await AgentSessionModel.create({
      conversationId: conversation._id,
      harness: 'claude-code',
      title: 'Race test',
      status: 'provisioning',
      createdBy: user._id,
    });

    // Simulate the real race: the background provisioning task is still
    // holding the pre-close in-memory session (fetched before the close
    // landed) when the request-driven close finishes.
    const staleInMemoryCopy = await AgentSessionModel.findById(session._id);
    if (!staleInMemoryCopy) throw new Error('setup failed');

    staleInMemoryCopy.status = 'closed';
    staleInMemoryCopy.sandboxPath = null;
    staleInMemoryCopy.closedAt = new Date();
    await staleInMemoryCopy.save();

    // The background task's catch block now runs, unaware the session was
    // just closed, and tries to flip it to 'error' using its own stale copy.
    const backgroundTaskCopy = await AgentSessionModel.findById(session._id);
    if (!backgroundTaskCopy) throw new Error('setup failed');
    await runtime.setStatus(backgroundTaskCopy, 'error', 'The sandbox could not be created');

    const final = await AgentSessionModel.findById(session._id);
    expect(final?.status).toBe('closed');
    expect(final?.closedAt).not.toBeNull();
    // The stale object returned to the caller must also reflect reality
    // rather than silently reporting the write it asked for.
    expect(backgroundTaskCopy.status).toBe('closed');
  });

  it('still applies the status change for a session that is not closed', async () => {
    const user = await makeUser('ada');
    const conversation = await ConversationModel.create({
      type: 'dm',
      memberIds: [user._id],
      createdBy: user._id,
      dmKey: makeDmKey(String(user._id), String(new Types.ObjectId())),
    });
    const session = await AgentSessionModel.create({
      conversationId: conversation._id,
      harness: 'claude-code',
      title: 'Normal case',
      status: 'provisioning',
      createdBy: user._id,
    });

    await runtime.setStatus(session, 'running');

    const final = await AgentSessionModel.findById(session._id);
    expect(final?.status).toBe('running');
  });
});
