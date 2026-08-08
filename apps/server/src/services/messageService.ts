import { Types } from 'mongoose';
import type {
  AgentQuestionPayload,
  ConversationSummary,
  MessageBlock,
  MessageKind,
  MessageWithAuthor,
} from '@teamagents/shared';
import { ConversationModel } from '../models/conversation.js';
import { MessageModel, type MessageDoc } from '../models/message.js';
import { UserModel, toUserPublic } from '../models/user.js';
import { hub } from '../realtime/hub.js';
import { buildSummary, previewFromBlocks, touchConversation } from './conversationService.js';
import { serializeMessage } from './serialize.js';
import { forbidden, notFound } from './errors.js';

export interface CreateMessageInput {
  conversationId: string;
  kind: MessageKind;
  authorKind: 'user' | 'agent' | 'system';
  authorUserId?: string | null;
  blocks: MessageBlock[];
  mentions?: string[];
  agentSessionId?: string | null;
  question?: AgentQuestionPayload | null;
}

/** Attaches the author's public profile to a serialized message. */
export async function withAuthor(doc: MessageDoc): Promise<MessageWithAuthor> {
  const base = serializeMessage(doc);
  if (base.author.kind !== 'user') return { ...base, authorUser: null };
  const user = await UserModel.findById(base.author.userId);
  return { ...base, authorUser: user ? toUserPublic(user) : null };
}

export async function withAuthors(docs: MessageDoc[]): Promise<MessageWithAuthor[]> {
  const userIds = new Set<string>();
  for (const doc of docs) if (doc.authorUserId) userIds.add(String(doc.authorUserId));
  const users = await UserModel.find({ _id: { $in: [...userIds] } });
  const byId = new Map(users.map((u) => [String(u._id), toUserPublic(u)]));
  return docs.map((doc) => {
    const base = serializeMessage(doc);
    return {
      ...base,
      authorUser: base.author.kind === 'user' ? (byId.get(base.author.userId) ?? null) : null,
    };
  });
}

/**
 * Persists a message, updates the conversation's sidebar state, and fans the
 * result out to every member. This is the single path through which anything —
 * a human, an agent, or the system — puts a message into a conversation.
 */
export async function createMessage(input: CreateMessageInput): Promise<MessageWithAuthor> {
  const conversation = await ConversationModel.findById(input.conversationId);
  if (!conversation) throw notFound('Conversation not found');

  const doc = await MessageModel.create({
    conversationId: new Types.ObjectId(input.conversationId),
    kind: input.kind,
    authorKind: input.authorKind,
    authorUserId: input.authorUserId ? new Types.ObjectId(input.authorUserId) : null,
    blocks: input.blocks,
    mentions: (input.mentions ?? []).map((id) => new Types.ObjectId(id)),
    agentSessionId: input.agentSessionId ? new Types.ObjectId(input.agentSessionId) : null,
    question: input.question ?? null,
  });

  const createdAt = (doc as unknown as { createdAt: Date }).createdAt;
  const authorName =
    input.authorKind === 'user' && input.authorUserId
      ? ((await UserModel.findById(input.authorUserId))?.firstName ?? undefined)
      : input.authorKind === 'agent'
        ? 'Agent'
        : undefined;
  await touchConversation(conversation._id, previewFromBlocks(input.blocks, authorName), createdAt);

  // The author has implicitly read their own message; advancing their marker
  // stops the sidebar from flashing an unread badge on their own send.
  if (input.authorKind === 'user' && input.authorUserId) {
    await ConversationModel.updateOne(
      { _id: conversation._id },
      { $set: { [`lastReadAt.${input.authorUserId}`]: createdAt } },
    );
  }

  const message = await withAuthor(doc);
  const fresh = await ConversationModel.findById(conversation._id);
  // Unread state is per viewer, so the sidebar payload is built once per member
  // rather than shared. That is a query per member per message, which is fine
  // for team-sized rooms (membership is capped at 200) and is what keeps the
  // badge correct without maintaining a counter that can drift.
  const summaries = new Map<string, ConversationSummary>();
  if (fresh) {
    for (const memberId of fresh.memberIds.map(String)) {
      summaries.set(memberId, await buildSummary(fresh, memberId));
    }
  }
  hub.emitMessage(message, summaries);
  return message;
}

/** Rewrites a message in place and pushes the update to open clients. */
export async function updateMessage(
  messageId: string,
  patch: Partial<{ blocks: MessageBlock[]; question: AgentQuestionPayload | null; editedAt: Date }>,
): Promise<MessageWithAuthor | null> {
  const doc = await MessageModel.findByIdAndUpdate(messageId, { $set: patch }, { new: true });
  if (!doc) return null;
  const message = await withAuthor(doc);
  hub.emitMessageUpdate(String(doc.conversationId), message);
  return message;
}

/**
 * Deletes a message on behalf of its author.
 *
 * The conversation's stored preview is rebuilt from whatever message is now
 * last, so deleting the newest message does not leave a ghost of it in the
 * sidebar.
 */
export async function deleteMessage(messageId: string, userId: string): Promise<void> {
  const doc = await MessageModel.findById(messageId);
  if (!doc) throw notFound('Message not found');
  if (doc.authorKind !== 'user' || String(doc.authorUserId) !== userId) {
    throw forbidden('You can only delete your own messages');
  }

  const conversationId = String(doc.conversationId);
  await doc.deleteOne();

  const latest = await MessageModel.findOne({ conversationId: doc.conversationId }).sort({ _id: -1 });
  const conversation = await ConversationModel.findById(conversationId);
  if (conversation) {
    if (latest) {
      const author =
        latest.authorKind === 'user' && latest.authorUserId
          ? ((await UserModel.findById(latest.authorUserId))?.firstName ?? undefined)
          : latest.authorKind === 'agent'
            ? 'Agent'
            : undefined;
      conversation.lastMessagePreview = previewFromBlocks(
        (latest.blocks ?? []) as MessageBlock[],
        author,
      );
      conversation.lastMessageAt = (latest as unknown as { createdAt: Date }).createdAt;
    } else {
      conversation.lastMessagePreview = null;
    }
    await conversation.save();
  }

  hub.emitMessageDelete(conversationId, messageId);
  await hub.pushConversationToMembers(conversationId);
}

/** Appends text to the trailing text block, creating one if needed. */
export async function appendTextToMessage(
  messageId: string,
  text: string,
): Promise<MessageWithAuthor | null> {
  const doc = await MessageModel.findById(messageId);
  if (!doc) return null;
  const blocks = [...((doc.blocks ?? []) as MessageBlock[])];
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    blocks[blocks.length - 1] = { type: 'text', text: last.text + text };
  } else {
    blocks.push({ type: 'text', text });
  }
  return updateMessage(messageId, { blocks });
}
