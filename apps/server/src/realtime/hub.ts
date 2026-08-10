import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { isValidObjectId } from 'mongoose';
import type {
  AgentEvent,
  AgentQuestionPayload,
  AgentSession,
  ClientToServerEvents,
  ConversationSummary,
  MessageWithAuthor,
  ServerToClientEvents,
  UserPublic,
} from '@teamagents/shared';
import { config } from '../config.js';
import { extractToken, verifyToken } from '../services/auth.js';
import { UserModel, toUserPublic } from '../models/user.js';
import { ConversationModel } from '../models/conversation.js';
import { buildSummary } from '../services/conversationService.js';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

interface SocketData {
  userId: string;
  user: UserPublic;
}

const userRoom = (userId: string) => `user:${userId}`;
const conversationRoom = (conversationId: string) => `conversation:${conversationId}`;

/**
 * Realtime fan-out.
 *
 * Two room families: one per user (so a person receives sidebar and notification
 * events on every device regardless of which chat is open) and one per
 * conversation (so open chats receive the message stream). Delivery is
 * best-effort — every event it carries is also reconstructible from the REST
 * API, which is what makes reconnects safe.
 */
export class RealtimeHub {
  private io: SocketServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData> | null =
    null;
  /** userId -> number of live sockets, for presence. */
  private readonly connections = new Map<string, number>();

  attach(httpServer: HttpServer): void {
    const io = new SocketServer<
      ClientToServerEvents,
      ServerToClientEvents,
      Record<string, never>,
      SocketData
    >(httpServer, {
      cors: { origin: config.webOrigins, credentials: true },
      // Messages carry code blocks and agent traces; the default 1 MB is tight.
      maxHttpBufferSize: 4 * 1024 * 1024,
    });

    io.use(async (socket, next) => {
      try {
        const token =
          extractToken({
            cookies: parseCookies(socket.handshake.headers.cookie),
            headers: socket.handshake.headers as unknown as Record<string, unknown>,
          }) ?? (socket.handshake.auth?.token as string | undefined) ?? null;
        if (!token) return next(new Error('unauthorized'));
        const payload = verifyToken(token);
        if (!payload) return next(new Error('unauthorized'));
        const user = await UserModel.findById(payload.sub);
        if (!user) return next(new Error('unauthorized'));
        socket.data.userId = String(user._id);
        socket.data.user = toUserPublic(user);
        next();
      } catch (error) {
        next(error as Error);
      }
    });

    io.on('connection', (socket) => void this.onConnection(socket));
    this.io = io;
  }

  private async onConnection(socket: TypedSocket): Promise<void> {
    const { userId } = socket.data;
    await socket.join(userRoom(userId));

    // Auto-join every conversation the user belongs to. Membership is small
    // enough here that this is cheaper than round-tripping a subscribe per chat.
    const conversations = await ConversationModel.find({ memberIds: userId }).select('_id');
    for (const conversation of conversations) {
      await socket.join(conversationRoom(String(conversation._id)));
    }

    const wasOffline = (this.connections.get(userId) ?? 0) === 0;
    this.connections.set(userId, (this.connections.get(userId) ?? 0) + 1);
    if (wasOffline) this.broadcastPresence(userId, true);
    socket.emit('presence:sync', { userIds: [...this.connections.keys()] });

    socket.on('conversation:subscribe', ({ conversationId }) => {
      void (async () => {
        // Membership must be re-checked here, not assumed: unlike the
        // auto-join above (computed once, from a trusted server-side query at
        // connect time), this handler takes an arbitrary id straight from the
        // client. Without this check any authenticated socket could join any
        // conversation's room just by naming its id, and would then receive
        // that conversation's message:update/message:delete/agent:* stream
        // regardless of actual membership.
        if (!isValidObjectId(conversationId)) return;
        const isMember = await ConversationModel.exists({
          _id: conversationId,
          memberIds: userId,
        });
        if (isMember) await socket.join(conversationRoom(conversationId));
      })();
    });
    socket.on('conversation:unsubscribe', ({ conversationId }) => {
      void socket.leave(conversationRoom(conversationId));
    });
    socket.on('typing', ({ conversationId, typing }) => {
      socket.to(conversationRoom(conversationId)).emit('typing', {
        conversationId,
        user: socket.data.user,
        typing,
      });
    });

    socket.on('disconnect', () => {
      const remaining = (this.connections.get(userId) ?? 1) - 1;
      if (remaining <= 0) {
        this.connections.delete(userId);
        this.broadcastPresence(userId, false);
      } else {
        this.connections.set(userId, remaining);
      }
    });
  }

  private broadcastPresence(userId: string, online: boolean): void {
    this.io?.emit('presence', { userId, online });
  }

  isOnline(userId: string): boolean {
    return (this.connections.get(userId) ?? 0) > 0;
  }

  /** Adds a user's live sockets to a conversation room (after being added to a group). */
  async addUserToConversationRoom(userId: string, conversationId: string): Promise<void> {
    const sockets = await this.io?.in(userRoom(userId)).fetchSockets();
    for (const socket of sockets ?? []) await socket.join(conversationRoom(conversationId));
  }

  /**
   * Evicts a user's live sockets from a conversation room (after being
   * removed from a group, or leaving one). Without this, an already-open tab
   * keeps receiving that conversation's message:update/message:delete/agent:*
   * events indefinitely — the room membership is otherwise never revisited
   * after the initial auto-join at connect time.
   */
  async removeUserFromConversationRoom(userId: string, conversationId: string): Promise<void> {
    const sockets = await this.io?.in(userRoom(userId)).fetchSockets();
    for (const socket of sockets ?? []) await socket.leave(conversationRoom(conversationId));
  }

  emitMessage(message: MessageWithAuthor, perViewerConversation: Map<string, ConversationSummary>): void {
    if (!this.io) return;
    // The message body is identical for everyone, but the conversation summary
    // that rides along carries per-viewer unread state, so it is sent per user.
    for (const [userId, conversation] of perViewerConversation) {
      this.io.to(userRoom(userId)).emit('message:new', { message, conversation });
    }
  }

  emitMessageUpdate(conversationId: string, message: MessageWithAuthor): void {
    this.io?.to(conversationRoom(conversationId)).emit('message:update', { message });
  }

  emitMessageDelete(conversationId: string, messageId: string): void {
    this.io?.to(conversationRoom(conversationId)).emit('message:delete', { conversationId, messageId });
  }

  emitConversationUpdate(userId: string, conversation: ConversationSummary): void {
    this.io?.to(userRoom(userId)).emit('conversation:update', { conversation });
  }

  emitConversationNew(userId: string, conversation: ConversationSummary): void {
    this.io?.to(userRoom(userId)).emit('conversation:new', { conversation });
  }

  emitAgentSession(conversationId: string, session: AgentSession): void {
    this.io?.to(conversationRoom(conversationId)).emit('agent:session', { session });
  }

  emitAgentEvent(conversationId: string, event: AgentEvent): void {
    this.io?.to(conversationRoom(conversationId)).emit('agent:event', { event });
  }

  emitAgentQuestion(conversationId: string, question: AgentQuestionPayload): void {
    this.io?.to(conversationRoom(conversationId)).emit('agent:question', { conversationId, question });
  }

  /** Recomputes and pushes the sidebar entry for every member of a conversation. */
  async pushConversationToMembers(conversationId: string, exceptUserId?: string): Promise<void> {
    const conversation = await ConversationModel.findById(conversationId);
    if (!conversation) return;
    for (const memberId of conversation.memberIds.map(String)) {
      if (memberId === exceptUserId) continue;
      const summary = await buildSummary(conversation, memberId);
      this.emitConversationUpdate(memberId, summary);
    }
  }

  async close(): Promise<void> {
    await this.io?.close();
    this.io = null;
    this.connections.clear();
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

/** Process-wide singleton so background services can push without a request. */
export const hub = new RealtimeHub();
