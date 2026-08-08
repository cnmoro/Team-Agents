import { Types } from 'mongoose';
import type { ConversationSummary, MessageBlock, UserPublic } from '@teamagents/shared';
import { ConversationModel, type ConversationDoc } from '../models/conversation.js';
import { MessageModel } from '../models/message.js';
import { UserModel, toUserPublic } from '../models/user.js';
import { serializeConversation } from './serialize.js';
import { forbidden, notFound } from './errors.js';

/** One-line preview of a message for the sidebar. */
export function previewFromBlocks(blocks: MessageBlock[], authorName?: string): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'code') parts.push(`[${block.language} snippet]`);
    else if (block.type === 'image') parts.push('[image]');
    else if (block.type === 'file') parts.push(`[${block.filename}]`);
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  return authorName ? `${authorName}: ${text}` : text;
}

/** Loads a conversation, asserting the user is a member. */
export async function getConversationForMember(
  conversationId: string,
  userId: string,
): Promise<ConversationDoc> {
  if (!Types.ObjectId.isValid(conversationId)) throw notFound('Conversation not found');
  const conversation = await ConversationModel.findById(conversationId);
  if (!conversation) throw notFound('Conversation not found');
  if (!conversation.memberIds.some((id) => String(id) === userId)) {
    throw forbidden('You are not a member of this conversation');
  }
  return conversation;
}

export function isMember(conversation: ConversationDoc, userId: string): boolean {
  return conversation.memberIds.some((id) => String(id) === userId);
}

/** The title a specific viewer sees: group name, or the other person's name. */
function resolveTitle(
  conversation: ConversationDoc,
  members: UserPublic[],
  viewerId: string,
): string {
  if (conversation.type === 'group') {
    if (conversation.name) return conversation.name;
    const others = members.filter((m) => m.id !== viewerId);
    return others.map((m) => m.firstName).join(', ') || 'Group';
  }
  const other = members.find((m) => m.id !== viewerId);
  // A DM with yourself (notes to self) falls back to your own name.
  return other?.displayName ?? members[0]?.displayName ?? 'Direct message';
}

interface UnreadStat {
  unreadCount: number;
  hasMention: boolean;
}

/**
 * Computes unread counts for several conversations in one aggregation.
 *
 * Unread means: created after the viewer's `lastReadAt` for that conversation
 * and not authored by the viewer. Deriving it from timestamps rather than
 * maintaining a counter keeps the badge correct even when a client misses
 * socket events or reconnects after downtime.
 */
export async function computeUnread(
  conversations: ConversationDoc[],
  viewerId: string,
): Promise<Map<string, UnreadStat>> {
  const result = new Map<string, UnreadStat>();
  if (conversations.length === 0) return result;

  const viewerObjectId = new Types.ObjectId(viewerId);
  const orClauses = conversations.map((conversation) => {
    const lastRead = conversation.lastReadAt?.get(viewerId) ?? null;
    return {
      conversationId: conversation._id,
      ...(lastRead ? { createdAt: { $gt: lastRead } } : {}),
    };
  });

  for (const conversation of conversations) {
    result.set(String(conversation._id), { unreadCount: 0, hasMention: false });
  }

  const rows = await MessageModel.aggregate<{
    _id: Types.ObjectId;
    unreadCount: number;
    mentionCount: number;
  }>([
    {
      $match: {
        $or: orClauses,
        // Your own messages never count as unread. System/agent messages do.
        $expr: { $ne: ['$authorUserId', viewerObjectId] },
      },
    },
    {
      $group: {
        _id: '$conversationId',
        unreadCount: { $sum: 1 },
        mentionCount: {
          $sum: { $cond: [{ $in: [viewerObjectId, { $ifNull: ['$mentions', []] }] }, 1, 0] },
        },
      },
    },
  ]);

  for (const row of rows) {
    result.set(String(row._id), {
      unreadCount: row.unreadCount,
      hasMention: row.mentionCount > 0,
    });
  }
  return result;
}

/** Builds the viewer-specific sidebar payload for a set of conversations. */
export async function buildSummaries(
  conversations: ConversationDoc[],
  viewerId: string,
): Promise<ConversationSummary[]> {
  if (conversations.length === 0) return [];

  const memberIds = new Set<string>();
  for (const conversation of conversations) {
    for (const id of conversation.memberIds) memberIds.add(String(id));
  }
  const users = await UserModel.find({ _id: { $in: [...memberIds] } });
  const userById = new Map(users.map((u) => [String(u._id), toUserPublic(u)]));

  const unread = await computeUnread(conversations, viewerId);

  return conversations.map((conversation) => {
    const members = conversation.memberIds
      .map((id) => userById.get(String(id)))
      .filter((u): u is UserPublic => Boolean(u));
    const stat = unread.get(String(conversation._id)) ?? { unreadCount: 0, hasMention: false };
    return {
      ...serializeConversation(conversation),
      members,
      title: resolveTitle(conversation, members, viewerId),
      lastMessagePreview: conversation.lastMessagePreview ?? null,
      unreadCount: stat.unreadCount,
      hasMention: stat.hasMention,
      lastReadAt: conversation.lastReadAt?.get(viewerId)?.toISOString() ?? null,
    };
  });
}

export async function buildSummary(
  conversation: ConversationDoc,
  viewerId: string,
): Promise<ConversationSummary> {
  const [summary] = await buildSummaries([conversation], viewerId);
  return summary!;
}

/** Bumps `lastMessageAt`/preview so the sidebar reorders correctly. */
export async function touchConversation(
  conversationId: Types.ObjectId | string,
  preview: string,
  at: Date,
): Promise<void> {
  await ConversationModel.updateOne(
    { _id: conversationId },
    { $set: { lastMessageAt: at, lastMessagePreview: preview } },
  );
}
