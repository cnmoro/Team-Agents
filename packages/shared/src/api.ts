/** REST request/response shapes. */

import type {
  Conversation,
  ConversationSummary,
  MessageBlock,
  MessageWithAuthor,
  UploadedFile,
  UserPublic,
} from './chat.js';

/** Every list endpoint returns this envelope. Cursors are opaque to the client. */
export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to fetch the next page. Null when exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface LoginInput {
  /** Email or username. */
  identifier: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  password: string;
}

export interface AuthResponse {
  user: UserPublic;
  token: string;
}

export interface CreateConversationInput {
  type: 'dm' | 'group';
  memberIds: string[];
  name?: string;
}

export interface SendMessageInput {
  blocks: MessageBlock[];
  mentions?: string[];
  /** Set to route this message as a follow-up prompt to a running agent. */
  agentSessionId?: string | null;
  /**
   * Chat messages to splice into the agent's context alongside this prompt.
   * Only meaningful together with `agentSessionId` — priming an ongoing
   * session the same way you can when first starting one.
   */
  contextMessageIds?: string[];
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

/** Default page size for message history. */
export const MESSAGE_PAGE_SIZE = 20;
export const DIRECTORY_PAGE_SIZE = 25;
export const CONVERSATION_PAGE_SIZE = 30;
export const TRACE_PAGE_SIZE = 50;

export type {
  Conversation,
  ConversationSummary,
  MessageWithAuthor,
  UploadedFile,
  UserPublic,
};
