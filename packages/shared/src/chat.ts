/** Users, conversations, messages, and the content blocks a message carries. */

export interface UserPublic {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  /** Convenience: `firstName lastName`, precomputed server-side. */
  displayName: string;
  /** Deterministic colour seed for the avatar fallback. */
  avatarColor: string;
  createdAt: string;
}

export type ConversationType = 'dm' | 'group';

export interface Conversation {
  id: string;
  type: ConversationType;
  /** Groups carry an explicit name; DMs derive their title from the other member. */
  name: string | null;
  memberIds: string[];
  createdBy: string;
  createdAt: string;
  lastMessageAt: string | null;
}

/** A conversation plus the viewer-specific state the sidebar needs. */
export interface ConversationSummary extends Conversation {
  members: UserPublic[];
  /** Title already resolved for the requesting viewer. */
  title: string;
  lastMessagePreview: string | null;
  unreadCount: number;
  /** True when an unread message mentions the viewer. */
  hasMention: boolean;
  lastReadAt: string | null;
}

// --- Message content blocks -------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

/** A Teams-style fenced code block: syntax highlighted with a copy button. */
export interface CodeBlock {
  type: 'code';
  language: string;
  code: string;
  /** Optional label shown in the block header (e.g. a filename). */
  filename?: string;
}

export interface FileBlock {
  type: 'file';
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ImageBlock {
  type: 'image';
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

export type MessageBlock = TextBlock | CodeBlock | FileBlock | ImageBlock;

/**
 * Wire format the composer writes for a mention: `@[Display Name](userId)` (or
 * `(agent)` for an `@Agent` mention). Ordinary markdown link syntax, chosen so
 * existing markdown renderers pass it through untouched until a dedicated
 * plugin turns it into a chip.
 *
 * Anything that shows message text *outside* the full markdown renderer (chat
 * notifications, sidebar previews, native OS notifications) needs to fall back
 * to plain `@Display Name` instead of leaking this wire syntax verbatim.
 */
const MENTION_MARKUP_PATTERN = /@\[([^\]]+)\]\((?:[0-9a-fA-F]{24}|agent)\)/g;

/** Rewrites `@[Name](id)` mention markup to plain `@Name` for non-markdown surfaces. */
export function stripMentionMarkup(text: string): string {
  return text.replace(MENTION_MARKUP_PATTERN, '@$1');
}

/** Languages offered in the composer's code-block picker. */
export const CODE_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'graphql',
  'html',
  'java',
  'javascript',
  'json',
  'kotlin',
  'lua',
  'markdown',
  'php',
  'plaintext',
  'powershell',
  'python',
  'ruby',
  'rust',
  'scala',
  'sql',
  'swift',
  'toml',
  'typescript',
  'xml',
  'yaml',
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

// --- Messages ---------------------------------------------------------------

export type MessageKind =
  /** Posted by a human. */
  | 'user'
  /** Marks the creation of an agent session; renders as the agent card. */
  | 'agent_session'
  /** Narrative output from a running agent. */
  | 'agent_output'
  /** A question the agent needs a human to answer. */
  | 'agent_question'
  /** Server-generated notice (member added, agent closed, ...). */
  | 'system';

export type MessageAuthor =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentSessionId: string }
  | { kind: 'system' };

/** Options offered alongside an agent question, rendered as buttons. */
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentQuestionPayload {
  questionId: string;
  agentSessionId: string;
  question: string;
  options: QuestionOption[];
  /** True when the user may type a free-form answer instead of picking. */
  allowFreeText: boolean;
  answeredBy: string | null;
  answeredAt: string | null;
  answerText: string | null;
  /** Set when the run was aborted or the session closed before an answer. */
  cancelled: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  kind: MessageKind;
  author: MessageAuthor;
  blocks: MessageBlock[];
  /** User ids mentioned via `@`. */
  mentions: string[];
  /** Set on every message that belongs to an agent session's thread. */
  agentSessionId: string | null;
  /** Only present on `agent_question` messages. */
  question: AgentQuestionPayload | null;
  createdAt: string;
  editedAt: string | null;
}

/** A message with its author resolved, as returned by the API. */
export interface MessageWithAuthor extends Message {
  authorUser: UserPublic | null;
}

export interface UploadedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  isImage: boolean;
  width?: number;
  height?: number;
  url: string;
}
