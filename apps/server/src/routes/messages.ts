import type { FastifyInstance } from 'fastify';
import { Types, type FilterQuery } from 'mongoose';
import { MESSAGE_PAGE_SIZE, type MessageBlock } from '@teamagents/shared';
import { FileModel } from '../models/file.js';
import { MessageModel } from '../models/message.js';
import { requireAuth } from '../services/auth.js';
import { getConversationForMember } from '../services/conversationService.js';
import { badRequest, notFound } from '../services/errors.js';
import { createMessage, deleteMessage, withAuthors } from '../services/messageService.js';
import { decodeIdCursor, encodeIdCursor } from '../services/pagination.js';
import { promptExistingAgent } from '../agents/agentService.js';
import { paginationSchema, sendMessageSchema } from './schemas.js';

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Message history, newest-first internally but returned oldest-first so the
   * client can prepend a page without reversing it. `cursor` is the id of the
   * oldest message already loaded; scrolling up pages backwards from there.
   */
  app.get('/api/conversations/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const { cursor, limit } = paginationSchema.parse(request.query);
    const pageSize = limit ?? MESSAGE_PAGE_SIZE;
    await getConversationForMember(id, String(request.currentUser._id));

    const filter: FilterQuery<unknown> = { conversationId: new Types.ObjectId(id) };
    if (cursor) filter._id = { $lt: decodeIdCursor(cursor) };

    const docs = await MessageModel.find(filter)
      .sort({ _id: -1 })
      .limit(pageSize + 1);

    const hasMore = docs.length > pageSize;
    const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;
    const oldest = pageDocs[pageDocs.length - 1];
    const items = await withAuthors(pageDocs.slice().reverse());

    return {
      items,
      nextCursor: hasMore && oldest ? encodeIdCursor(oldest._id) : null,
      hasMore,
    };
  });

  /**
   * Posts a message. When `agentSessionId` is set the same text is also
   * delivered to that agent as a follow-up prompt, which is what makes an agent
   * card behave like a thread you can keep talking to.
   */
  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = sendMessageSchema.parse(request.body);
    const viewerId = String(request.currentUser._id);
    const conversation = await getConversationForMember(id, viewerId);

    const blocks = await resolveFileBlocks(input.blocks, id);

    // Only mentions of actual members are stored; anything else would create a
    // notification the recipient could never act on.
    const memberIds = new Set(conversation.memberIds.map(String));
    const mentions = (input.mentions ?? []).filter((mentionId) => memberIds.has(mentionId));

    const message = await createMessage({
      conversationId: id,
      kind: 'user',
      authorKind: 'user',
      authorUserId: viewerId,
      blocks,
      mentions,
      agentSessionId: input.agentSessionId ?? null,
    });

    if (input.agentSessionId) {
      const prompt = blocks
        .map((block) =>
          block.type === 'text'
            ? block.text
            : block.type === 'code'
              ? `\n\`\`\`${block.language}\n${block.code}\n\`\`\`\n`
              : '',
        )
        .join('')
        .trim();
      if (prompt) {
        // Fire-and-forget: the agent streams its progress over sockets, so the
        // sender's POST must not block for the length of an agent turn.
        void promptExistingAgent(input.agentSessionId, viewerId, { prompt }).catch((error) => {
          request.log.error({ err: error, agentSessionId: input.agentSessionId }, 'agent prompt failed');
        });
      }
    }

    return reply.code(201).send(message);
  });

  /** Authors can remove their own messages; nobody can remove anyone else's. */
  app.delete('/api/messages/:id', async (request) => {
    const { id } = request.params as { id: string };
    await deleteMessage(id, String(request.currentUser._id));
    return { ok: true };
  });

  app.get('/api/messages/:id', async (request) => {
    const { id } = request.params as { id: string };
    const doc = await MessageModel.findById(id);
    if (!doc) throw notFound('Message not found');
    await getConversationForMember(String(doc.conversationId), String(request.currentUser._id));
    const [message] = await withAuthors([doc]);
    return message;
  });
}

/**
 * Replaces client-supplied file metadata with the values recorded at upload
 * time. The browser can claim any size or filename it likes; only the File
 * document is trusted.
 */
async function resolveFileBlocks(
  blocks: MessageBlock[],
  conversationId: string,
): Promise<MessageBlock[]> {
  const fileIds = blocks
    .filter((b): b is Extract<MessageBlock, { fileId: string }> => 'fileId' in b)
    .map((b) => b.fileId);
  if (fileIds.length === 0) return blocks;

  const files = await FileModel.find({ _id: { $in: fileIds } });
  const byId = new Map(files.map((f) => [String(f._id), f]));

  return blocks.map((block) => {
    if (!('fileId' in block)) return block;
    const file = byId.get(block.fileId);
    if (!file) throw badRequest(`Attachment ${block.fileId} was not found`);
    if (String(file.conversationId) !== conversationId) {
      throw badRequest('Attachment belongs to a different conversation');
    }
    const common = {
      fileId: String(file._id),
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
    };
    return file.isImage
      ? {
          type: 'image' as const,
          ...common,
          width: file.width ?? undefined,
          height: file.height ?? undefined,
        }
      : { type: 'file' as const, ...common };
  });
}
