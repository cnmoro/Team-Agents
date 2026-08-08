import type { FastifyInstance } from 'fastify';
import { Types, type FilterQuery } from 'mongoose';
import { TRACE_PAGE_SIZE } from '@teamagents/shared';
import { AgentEventModel } from '../models/agentEvent.js';
import { requireAuth } from '../services/auth.js';
import { badRequest } from '../services/errors.js';
import { serializeAgentEvent } from '../services/serialize.js';
import { buildPage, decodeIdCursor, encodeIdCursor } from '../services/pagination.js';
import {
  abortAgent,
  answerAgentQuestion,
  closeAgent,
  listAllSessionsForUser,
  listSessionsForConversation,
  loadSessionForMember,
  promptExistingAgent,
  startAgent,
} from '../agents/agentService.js';
import { answerQuestionSchema, paginationSchema, promptAgentSchema, startAgentSchema } from './schemas.js';

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** `@Agent` in the composer lands here. */
  app.post('/api/agents', async (request, reply) => {
    const input = startAgentSchema.parse(request.body);
    const session = await startAgent(input as never, String(request.currentUser._id));
    return reply.code(201).send(session);
  });

  /** Every session the user can reach, so one can always be found and closed. */
  app.get('/api/agents', async (request) => {
    return listAllSessionsForUser(String(request.currentUser._id));
  });

  app.get('/api/conversations/:id/agents', async (request) => {
    const { id } = request.params as { id: string };
    return listSessionsForConversation(id, String(request.currentUser._id));
  });

  app.get('/api/agents/:id', async (request) => {
    const { id } = request.params as { id: string };
    const session = await loadSessionForMember(id, String(request.currentUser._id));
    const { serializeAgentSession } = await import('../services/serialize.js');
    return serializeAgentSession(session);
  });

  /** Follow-up prompt: reuses the sandbox and the harness's own session. */
  app.post('/api/agents/:id/prompt', async (request) => {
    const { id } = request.params as { id: string };
    const input = promptAgentSchema.parse(request.body);
    return promptExistingAgent(id, String(request.currentUser._id), input);
  });

  /** Any member of the conversation may answer; the first answer wins. */
  app.post('/api/agents/:id/answer', async (request) => {
    const { id } = request.params as { id: string };
    const input = answerQuestionSchema.parse(request.body);
    const session = await loadSessionForMember(id, String(request.currentUser._id));

    // An option id is resolved to its label so the agent receives the words the
    // user actually saw, not an internal identifier.
    let answerText = input.text?.trim() ?? '';
    if (input.optionId) {
      const { MessageModel } = await import('../models/message.js');
      const message = await MessageModel.findOne({
        agentSessionId: session._id,
        'question.questionId': input.questionId,
      });
      const question = message?.question as
        | { options?: Array<{ id: string; label: string }> }
        | undefined;
      const option = question?.options?.find((candidate) => candidate.id === input.optionId);
      if (option) answerText = answerText ? `${option.label} — ${answerText}` : option.label;
    }
    if (!answerText) throw badRequest('An answer is required');

    await answerAgentQuestion(
      id,
      String(request.currentUser._id),
      input.questionId,
      answerText,
    );
    return { ok: true };
  });

  app.post('/api/agents/:id/abort', async (request) => {
    const { id } = request.params as { id: string };
    await abortAgent(id, String(request.currentUser._id));
    return { ok: true };
  });

  /** Destroys the sandbox. Irreversible; the UI confirms before calling. */
  app.delete('/api/agents/:id', async (request) => {
    const { id } = request.params as { id: string };
    return closeAgent(id, String(request.currentUser._id));
  });

  /** The toggleable trace. Paginated, oldest first. */
  app.get('/api/agents/:id/events', async (request) => {
    const { id } = request.params as { id: string };
    const { cursor, limit } = paginationSchema.parse(request.query);
    const pageSize = limit ?? TRACE_PAGE_SIZE;
    await loadSessionForMember(id, String(request.currentUser._id));

    const filter: FilterQuery<unknown> = { agentSessionId: new Types.ObjectId(id) };
    if (cursor) filter._id = { $gt: decodeIdCursor(cursor) };

    const docs = await AgentEventModel.find(filter)
      .sort({ seq: 1 })
      .limit(pageSize + 1);

    return buildPage(docs, pageSize, serializeAgentEvent, (doc) => encodeIdCursor(doc._id));
  });
}
