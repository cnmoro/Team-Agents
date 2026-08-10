import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '../config.js';
import { connectDatabase, disconnectDatabase, mongoose } from '../db.js';
import { ConversationModel, makeDmKey } from '../models/conversation.js';
import { FileModel } from '../models/file.js';
import { MessageModel } from '../models/message.js';
import { UserModel, buildSearchKey, pickAvatarColor } from '../models/user.js';
import { AgentSessionModel } from '../models/agentSession.js';
import { buildContextTranscript, closeAgent } from './agentService.js';

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
    await rm(path.join(paths.uploads, '2026-08-10'), { recursive: true, force: true });
  });

  beforeEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
      FileModel.deleteMany({}),
    ]);
  });

  /** Writes a real file under the uploads dir and its matching FileModel doc. */
  async function makeStoredFile(opts: {
    filename: string;
    mimeType: string;
    content: Buffer;
    conversationId: Types.ObjectId;
    uploadedBy: Types.ObjectId;
    isImage?: boolean;
    width?: number;
    height?: number;
  }) {
    const relativeDir = '2026-08-10';
    const storageName = `${randomUUID()}${path.extname(opts.filename)}`;
    const relativePath = path.join(relativeDir, storageName);
    const absolutePath = path.join(paths.uploads, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, opts.content);

    return FileModel.create({
      filename: opts.filename,
      mimeType: opts.mimeType,
      size: opts.content.length,
      sha256: 'test',
      storagePath: relativePath,
      uploadedBy: opts.uploadedBy,
      conversationId: opts.conversationId,
      isImage: opts.isImage ?? false,
      width: opts.width ?? null,
      height: opts.height ?? null,
    });
  }

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

  it('inlines the real content of a text-file attachment instead of just its filename', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const conversation = await ConversationModel.create({
      type: 'dm',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      dmKey: makeDmKey(String(ada._id), String(alan._id)),
      lastMessageAt: new Date(),
    });

    const secret = 'THE-SECRET-CODE-IS-QUOKKA-42';
    const file = await makeStoredFile({
      filename: 'notes.txt',
      mimeType: 'text/plain',
      content: Buffer.from(`some notes\n${secret}\nmore notes`),
      conversationId: conversation._id,
      uploadedBy: ada._id,
    });

    const message = await MessageModel.create({
      conversationId: conversation._id,
      kind: 'user',
      authorKind: 'user',
      authorUserId: ada._id,
      blocks: [
        {
          type: 'file',
          fileId: String(file._id),
          filename: 'notes.txt',
          mimeType: 'text/plain',
          size: file.size,
        },
      ],
    });

    const transcript = await buildContextTranscript(String(conversation._id), [
      String(message._id),
    ]);

    expect(transcript).toContain(secret);
    expect(transcript).toContain('notes.txt');
    expect(transcript).not.toBe('[attachment: notes.txt]');
  });

  it('describes an image attachment with metadata instead of a bare filename tag, without claiming to show its content', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const conversation = await ConversationModel.create({
      type: 'dm',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      dmKey: makeDmKey(String(ada._id), String(alan._id)),
      lastMessageAt: new Date(),
    });

    const file = await makeStoredFile({
      filename: 'diagram.png',
      mimeType: 'image/png',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      conversationId: conversation._id,
      uploadedBy: ada._id,
      isImage: true,
      width: 10,
      height: 5,
    });

    const message = await MessageModel.create({
      conversationId: conversation._id,
      kind: 'user',
      authorKind: 'user',
      authorUserId: ada._id,
      blocks: [
        {
          type: 'image',
          fileId: String(file._id),
          filename: 'diagram.png',
          mimeType: 'image/png',
          size: file.size,
        },
      ],
    });

    const transcript = await buildContextTranscript(String(conversation._id), [
      String(message._id),
    ]);

    expect(transcript).toContain('diagram.png');
    expect(transcript).toContain('10x5');
    expect(transcript).toContain('not visible');
  });

  it('flags a binary (non-text) file attachment without dumping raw bytes into the transcript', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const conversation = await ConversationModel.create({
      type: 'dm',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      dmKey: makeDmKey(String(ada._id), String(alan._id)),
      lastMessageAt: new Date(),
    });

    const file = await makeStoredFile({
      filename: 'archive.bin',
      mimeType: 'application/octet-stream',
      content: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x00]),
      conversationId: conversation._id,
      uploadedBy: ada._id,
    });

    const message = await MessageModel.create({
      conversationId: conversation._id,
      kind: 'user',
      authorKind: 'user',
      authorUserId: ada._id,
      blocks: [
        {
          type: 'file',
          fileId: String(file._id),
          filename: 'archive.bin',
          mimeType: 'application/octet-stream',
          size: file.size,
        },
      ],
    });

    const transcript = await buildContextTranscript(String(conversation._id), [
      String(message._id),
    ]);

    expect(transcript).toContain('archive.bin');
    expect(transcript).toContain('binary file, content not shown');
  });
});

/**
 * Regression guard, 23rd QA pass: two concurrent "Close & erase" calls on the
 * same session (a double-click, or two different users both hitting it at
 * once — reproduced live in the QA lab via two real users' bearer tokens
 * racing `DELETE /api/agents/:id`) each ran the full close side-effect chain
 * (teardown, sandbox destroy, a "closed the agent" system message, a
 * conversation-summary broadcast) with no guard against the session already
 * being closed — unlike `promptExistingAgent`, which does check. The
 * observable symptom was two separate "X closed the agent ... and cleared
 * its sandbox." system messages landing in the chat for one real close,
 * attributed to two different users, even though only one of them "really"
 * closed anything.
 */
describe('closeAgent', () => {
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
      AgentSessionModel.deleteMany({}),
    ]);
  });

  it('two concurrent closes of the same session only post one "closed" system message', async () => {
    const ada = await makeUser('ada');
    const alan = await makeUser('alan');
    const conversation = await ConversationModel.create({
      type: 'group',
      memberIds: [ada._id, alan._id],
      createdBy: ada._id,
      title: 'Close race',
    });

    const session = await AgentSessionModel.create({
      conversationId: conversation._id,
      harness: 'claude-code',
      title: 'Close race session',
      status: 'idle',
      createdBy: ada._id,
    });

    // Two different users racing the real close path concurrently, exactly
    // as reproduced live via two bearer tokens hitting DELETE at once.
    await Promise.all([
      closeAgent(String(session._id), String(ada._id)),
      closeAgent(String(session._id), String(alan._id)),
    ]);

    const final = await AgentSessionModel.findById(session._id);
    expect(final?.status).toBe('closed');

    const closeMessages = await MessageModel.find({
      conversationId: conversation._id,
      kind: 'system',
      'blocks.text': { $regex: /closed the agent/ },
    });
    expect(closeMessages).toHaveLength(1);
  });
});
