import type { FastifyInstance } from 'fastify';
import { Types, type FilterQuery } from 'mongoose';
import { CONVERSATION_PAGE_SIZE } from '@teamagents/shared';
import { ConversationModel, makeDmKey } from '../models/conversation.js';
import { UserModel } from '../models/user.js';
import { requireAuth } from '../services/auth.js';
import {
  buildSummaries,
  buildSummary,
  getConversationForMember,
} from '../services/conversationService.js';
import { badRequest, forbidden, notFound } from '../services/errors.js';
import { createMessage } from '../services/messageService.js';
import {
  buildPage,
  decodeCompoundCursor,
  encodeCompoundCursor,
} from '../services/pagination.js';
import { hub } from '../realtime/hub.js';
import {
  createConversationSchema,
  paginationSchema,
  updateConversationSchema,
} from './schemas.js';

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Sidebar list: most recently active first. */
  app.get('/api/conversations', async (request) => {
    const { cursor, limit } = paginationSchema.parse(request.query);
    const pageSize = limit ?? CONVERSATION_PAGE_SIZE;
    const viewerId = String(request.currentUser._id);

    const filter: FilterQuery<unknown> = { memberIds: request.currentUser._id };
    if (cursor) {
      const { sortValue, id } = decodeCompoundCursor(cursor);
      const at = new Date(sortValue);
      filter.$or = [{ lastMessageAt: { $lt: at } }, { lastMessageAt: at, _id: { $lt: id } }];
    }

    const docs = await ConversationModel.find(filter)
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(pageSize + 1);

    const hasMore = docs.length > pageSize;
    const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;
    const summaries = await buildSummaries(pageDocs, viewerId);
    const last = pageDocs[pageDocs.length - 1];

    return {
      items: summaries,
      nextCursor:
        hasMore && last
          ? encodeCompoundCursor(
              (last.lastMessageAt ?? new Date(0)).toISOString(),
              last._id,
            )
          : null,
      hasMore,
    };
  });

  /**
   * Creates a DM or group. Re-requesting a DM that already exists returns the
   * existing conversation rather than a duplicate, so "message this person"
   * is idempotent from anywhere in the UI.
   */
  app.post('/api/conversations', async (request, reply) => {
    const input = createConversationSchema.parse(request.body);
    const viewerId = String(request.currentUser._id);

    const otherIds = input.memberIds.filter((id) => id !== viewerId);
    const memberIds = [...new Set([viewerId, ...otherIds])];

    const found = await UserModel.countDocuments({ _id: { $in: memberIds } });
    if (found !== memberIds.length) throw badRequest('One or more members do not exist');

    const now = new Date();

    if (input.type === 'dm') {
      const otherId = otherIds[0] ?? viewerId;
      const dmKey = makeDmKey(viewerId, otherId);
      const existing = await ConversationModel.findOne({ dmKey });
      if (existing) return reply.code(200).send(await buildSummary(existing, viewerId));

      const created = await ConversationModel.create({
        type: 'dm',
        name: null,
        memberIds: [...new Set([viewerId, otherId])].map((id) => new Types.ObjectId(id)),
        createdBy: request.currentUser._id,
        dmKey,
        // Seeded so an empty conversation still sorts sensibly in the sidebar.
        lastMessageAt: now,
      });
      await notifyNewConversation(created._id, viewerId);
      return reply.code(201).send(await buildSummary(created, viewerId));
    }

    const created = await ConversationModel.create({
      type: 'group',
      name: input.name!.trim(),
      memberIds: memberIds.map((id) => new Types.ObjectId(id)),
      createdBy: request.currentUser._id,
      dmKey: null,
      lastMessageAt: now,
    });
    await createMessage({
      conversationId: String(created._id),
      kind: 'system',
      authorKind: 'system',
      blocks: [
        {
          type: 'text',
          text: `${request.currentUser.firstName} created the group "${created.name}".`,
        },
      ],
    });
    await notifyNewConversation(created._id, viewerId);
    return reply.code(201).send(await buildSummary(created, viewerId));
  });

  app.get('/api/conversations/:id', async (request) => {
    const { id } = request.params as { id: string };
    const viewerId = String(request.currentUser._id);
    const conversation = await getConversationForMember(id, viewerId);
    return buildSummary(conversation, viewerId);
  });

  app.patch('/api/conversations/:id', async (request) => {
    const { id } = request.params as { id: string };
    const viewerId = String(request.currentUser._id);
    const input = updateConversationSchema.parse(request.body);
    const conversation = await getConversationForMember(id, viewerId);
    if (conversation.type === 'dm') throw badRequest('Direct messages cannot be modified');

    const notices: string[] = [];

    if (input.name && input.name.trim() !== conversation.name) {
      const previous = conversation.name;
      conversation.name = input.name.trim();
      notices.push(`${request.currentUser.firstName} renamed the group from "${previous}" to "${conversation.name}".`);
    }

    if (input.addMemberIds?.length) {
      const toAdd = input.addMemberIds.filter(
        (candidate) => !conversation.memberIds.some((existing) => String(existing) === candidate),
      );
      if (toAdd.length) {
        const users = await UserModel.find({ _id: { $in: toAdd } });
        if (users.length !== toAdd.length) throw badRequest('One or more members do not exist');
        conversation.memberIds.push(...toAdd.map((memberId) => new Types.ObjectId(memberId)));
        notices.push(
          `${request.currentUser.firstName} added ${users.map((u) => u.firstName).join(', ')}.`,
        );
      }
    }

    if (input.removeMemberIds?.length) {
      const removing = new Set(input.removeMemberIds);
      const users = await UserModel.find({ _id: { $in: [...removing] } });
      conversation.memberIds = conversation.memberIds.filter((mid) => !removing.has(String(mid)));
      if (conversation.memberIds.length === 0) throw badRequest('A group needs at least one member');
      notices.push(
        `${request.currentUser.firstName} removed ${users.map((u) => u.firstName).join(', ')}.`,
      );
    }

    await conversation.save();

    for (const notice of notices) {
      await createMessage({
        conversationId: id,
        kind: 'system',
        authorKind: 'system',
        blocks: [{ type: 'text', text: notice }],
      });
    }

    for (const memberId of input.addMemberIds ?? []) {
      await hub.addUserToConversationRoom(memberId, id);
      hub.emitConversationNew(memberId, await buildSummary(conversation, memberId));
    }
    await hub.pushConversationToMembers(id);

    return buildSummary(conversation, viewerId);
  });

  /** Clears the unread highlight by advancing the viewer's read marker. */
  app.post('/api/conversations/:id/read', async (request) => {
    const { id } = request.params as { id: string };
    const viewerId = String(request.currentUser._id);
    await getConversationForMember(id, viewerId);
    await ConversationModel.updateOne(
      { _id: id },
      { $set: { [`lastReadAt.${viewerId}`]: new Date() } },
    );
    const fresh = await ConversationModel.findById(id);
    if (!fresh) throw notFound('Conversation not found');
    const summary = await buildSummary(fresh, viewerId);
    // Pushed back to the reader's other devices so the badge clears everywhere.
    hub.emitConversationUpdate(viewerId, summary);
    return summary;
  });

  /** Leaving is the only way a member removes themselves from a group. */
  app.post('/api/conversations/:id/leave', async (request) => {
    const { id } = request.params as { id: string };
    const viewerId = String(request.currentUser._id);
    const conversation = await getConversationForMember(id, viewerId);
    if (conversation.type === 'dm') throw forbidden('You cannot leave a direct message');
    conversation.memberIds = conversation.memberIds.filter((mid) => String(mid) !== viewerId);
    await conversation.save();
    await createMessage({
      conversationId: id,
      kind: 'system',
      authorKind: 'system',
      blocks: [{ type: 'text', text: `${request.currentUser.firstName} left the group.` }],
    });
    await hub.pushConversationToMembers(id);
    return { ok: true };
  });
}

async function notifyNewConversation(
  conversationId: Types.ObjectId,
  exceptUserId: string,
): Promise<void> {
  const conversation = await ConversationModel.findById(conversationId);
  if (!conversation) return;
  for (const memberId of conversation.memberIds.map(String)) {
    await hub.addUserToConversationRoom(memberId, String(conversationId));
    if (memberId === exceptUserId) continue;
    hub.emitConversationNew(memberId, await buildSummary(conversation, memberId));
  }
}
