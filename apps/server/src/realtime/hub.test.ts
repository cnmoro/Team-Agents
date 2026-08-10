import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase, mongoose } from '../db.js';
import { ConversationModel } from '../models/conversation.js';
import { UserModel, buildSearchKey, pickAvatarColor } from '../models/user.js';
import { signToken } from '../services/auth.js';
import { RealtimeHub } from './hub.js';

/**
 * Runs against a real MongoDB and a real socket.io server/client pair over a
 * real loopback HTTP connection (not mocked), covering the two access-control
 * gaps found by hands-on QA:
 *
 * 1. `conversation:subscribe` used to join the caller's socket to *any*
 *    conversation room purely from the client-supplied id, with no
 *    membership check — a total stranger to a conversation could subscribe
 *    to its live message:update/message:delete/agent:* stream just by
 *    knowing (or guessing) its id.
 * 2. Removing a member from a group (or a member leaving) never evicted
 *    their already-connected socket from that conversation's room, so a
 *    still-open tab kept receiving that conversation's realtime events
 *    indefinitely even though REST access was correctly revoked.
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

function waitFor(socket: ClientSocket, event: string, timeoutMs = 1500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** True if `event` never arrives within a short grace window. */
async function neverReceives(socket: ClientSocket, event: string, waitMs = 400): Promise<boolean> {
  let fired = false;
  const handler = () => {
    fired = true;
  };
  socket.on(event, handler);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  socket.off(event, handler);
  return !fired;
}

describe('RealtimeHub conversation room access control', () => {
  let httpServer: HttpServer;
  let hub: RealtimeHub;
  let baseUrl: string;

  beforeAll(async () => {
    await connectDatabase(TEST_URI);
    httpServer = createServer();
    hub = new RealtimeHub();
    hub.attach(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await hub.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await mongoose.connection.dropDatabase();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await ConversationModel.deleteMany({});
  });

  const clients: ClientSocket[] = [];
  function connect(token: string): ClientSocket {
    const socket = ioClient(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
    clients.push(socket);
    return socket;
  }

  afterEach(() => {
    for (const socket of clients.splice(0)) socket.close();
  });

  it('rejects conversation:subscribe for a user who is not a member of that conversation', async () => {
    const owner = await makeUser('owner1');
    const stranger = await makeUser('stranger1');
    const conversation = await ConversationModel.create({
      type: 'group',
      name: 'Private group',
      memberIds: [owner._id],
      createdBy: owner._id,
      dmKey: null,
      lastMessageAt: new Date(),
    });

    const strangerSocket = connect(signToken(stranger));
    await waitFor(strangerSocket, 'presence:sync');

    strangerSocket.emit('conversation:subscribe', { conversationId: String(conversation._id) });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A stranger's subscribe attempt must not land them in the room: an
    // event broadcast to the room should never reach their socket.
    const sawIt = await neverReceives(strangerSocket, 'message:delete');
    hub.emitMessageDelete(String(conversation._id), 'fake-message-id');
    const stillNeverSaw = await neverReceives(strangerSocket, 'message:delete');
    expect(sawIt && stillNeverSaw).toBe(true);
  });

  it('allows conversation:subscribe for an actual member', async () => {
    const owner = await makeUser('owner2');
    const conversation = await ConversationModel.create({
      type: 'group',
      name: 'Owned group',
      memberIds: [owner._id],
      createdBy: owner._id,
      dmKey: null,
      lastMessageAt: new Date(),
    });

    const ownerSocket = connect(signToken(owner));
    await waitFor(ownerSocket, 'presence:sync');
    ownerSocket.emit('conversation:subscribe', { conversationId: String(conversation._id) });
    await new Promise((resolve) => setTimeout(resolve, 200));

    hub.emitMessageDelete(String(conversation._id), 'real-message-id');
    const payload = await waitFor(ownerSocket, 'message:delete');
    expect(payload).toEqual({ conversationId: String(conversation._id), messageId: 'real-message-id' });
  });

  it('evicts a removed member\'s live socket from the conversation room', async () => {
    const owner = await makeUser('owner3');
    const member = await makeUser('member3');
    const conversation = await ConversationModel.create({
      type: 'group',
      name: 'Shrinking group',
      memberIds: [owner._id, member._id],
      createdBy: owner._id,
      dmKey: null,
      lastMessageAt: new Date(),
    });

    // Auto-joins the room on connect, exactly like a real already-open tab.
    const memberSocket = connect(signToken(member));
    await waitFor(memberSocket, 'presence:sync');

    hub.emitMessageDelete(String(conversation._id), 'still-a-member');
    await waitFor(memberSocket, 'message:delete');

    await hub.removeUserFromConversationRoom(String(member._id), String(conversation._id));

    hub.emitMessageDelete(String(conversation._id), 'after-removal');
    const missedIt = await neverReceives(memberSocket, 'message:delete');
    expect(missedIt).toBe(true);
  });
});
