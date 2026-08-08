/** Socket.IO event names and payloads. */

import type {
  ConversationSummary,
  MessageWithAuthor,
  UserPublic,
  AgentQuestionPayload,
} from './chat.js';
import type { AgentEvent, AgentSession } from './agents.js';

/** Server -> client. */
export interface ServerToClientEvents {
  /** A message was posted in a conversation the socket belongs to. */
  'message:new': (payload: { message: MessageWithAuthor; conversation: ConversationSummary }) => void;
  /** A message was edited in place (agent output streaming, question answered). */
  'message:update': (payload: { message: MessageWithAuthor }) => void;
  /** A message was deleted by its author. */
  'message:delete': (payload: { conversationId: string; messageId: string }) => void;
  /** Sidebar state changed: unread counts, title, membership, ordering. */
  'conversation:update': (payload: { conversation: ConversationSummary }) => void;
  /** The viewer was added to a new conversation. */
  'conversation:new': (payload: { conversation: ConversationSummary }) => void;
  /** An agent session was created or changed status. */
  'agent:session': (payload: { session: AgentSession }) => void;
  /** A trace event was appended to an agent session. */
  'agent:event': (payload: { event: AgentEvent }) => void;
  /** An agent asked a question; drives the toast and the inline prompt. */
  'agent:question': (payload: { conversationId: string; question: AgentQuestionPayload }) => void;
  /** Someone is typing in a conversation. */
  'typing': (payload: { conversationId: string; user: UserPublic; typing: boolean }) => void;
  /** A user's connection state changed. */
  'presence': (payload: { userId: string; online: boolean }) => void;
  /** Full set of currently-online user ids, sent on connect. */
  'presence:sync': (payload: { userIds: string[] }) => void;
}

/** Client -> server. */
export interface ClientToServerEvents {
  /** Join the room for a conversation so its events are delivered. */
  'conversation:subscribe': (payload: { conversationId: string }) => void;
  'conversation:unsubscribe': (payload: { conversationId: string }) => void;
  'typing': (payload: { conversationId: string; typing: boolean }) => void;
}

export const SOCKET_PATH = '/socket.io';
