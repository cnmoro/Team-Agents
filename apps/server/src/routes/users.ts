import type { FastifyInstance } from 'fastify';
import type { FilterQuery } from 'mongoose';
import { DIRECTORY_PAGE_SIZE } from '@teamagents/shared';
import { UserModel, toUserPublic } from '../models/user.js';
import { requireAuth } from '../services/auth.js';
import { getConversationForMember } from '../services/conversationService.js';
import { buildPage, decodeCompoundCursor, encodeCompoundCursor } from '../services/pagination.js';
import { directorySchema } from './schemas.js';

/** Escapes a user-supplied string for safe use inside a RegExp. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The user directory backing "new chat", "new group", and the `@` mention
   * menu. Searches email, username, and first+last name in one pass by matching
   * against the precomputed `searchKey`.
   */
  app.get('/api/users', { preHandler: requireAuth }, async (request) => {
    const { query, cursor, limit, conversationId } = directorySchema.parse(request.query);
    const pageSize = limit ?? DIRECTORY_PAGE_SIZE;

    const filter: FilterQuery<unknown> = {};

    if (conversationId) {
      // Mention menus only offer people who are actually in the conversation.
      const conversation = await getConversationForMember(
        conversationId,
        String(request.currentUser._id),
      );
      filter._id = { $in: conversation.memberIds };
    }

    const trimmed = query?.trim();
    if (trimmed) {
      // Every whitespace-separated term must appear somewhere in the search key,
      // so "ada love" and "love ada" both find Ada Lovelace.
      const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
      filter.$and = terms.map((term) => ({ searchKey: { $regex: escapeRegex(term) } }));
    }

    if (cursor) {
      const { sortValue, id } = decodeCompoundCursor(cursor);
      const after = {
        $or: [{ searchKey: { $gt: sortValue } }, { searchKey: sortValue, _id: { $gt: id } }],
      };
      filter.$and = [...((filter.$and as object[]) ?? []), after];
    }

    const docs = await UserModel.find(filter)
      .sort({ searchKey: 1, _id: 1 })
      .limit(pageSize + 1);

    return buildPage(docs, pageSize, toUserPublic, (doc) =>
      encodeCompoundCursor(doc.searchKey, doc._id),
    );
  });

  app.get('/api/users/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await UserModel.findById(id);
    if (!user) return { user: null };
    return { user: toUserPublic(user) };
  });
}
