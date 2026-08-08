import type {
  AgentEvent,
  AgentSession,
  Conversation,
  CredentialSummary,
  Message,
  MessageBlock,
  Repository,
  UploadedFile,
} from '@teamagents/shared';
import type { AgentEventDoc } from '../models/agentEvent.js';
import type { AgentSessionDoc } from '../models/agentSession.js';
import type { ConversationDoc } from '../models/conversation.js';
import type { CredentialDoc } from '../models/credential.js';
import type { FileDoc } from '../models/file.js';
import type { MessageDoc } from '../models/message.js';
import type { RepositoryDoc } from '../models/repository.js';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoRequired = (d: Date): string => d.toISOString();

type Timestamped = { createdAt: Date; updatedAt: Date };

export function serializeConversation(doc: ConversationDoc): Conversation {
  const ts = doc as unknown as Timestamped;
  return {
    id: String(doc._id),
    type: doc.type as 'dm' | 'group',
    name: doc.name ?? null,
    memberIds: doc.memberIds.map(String),
    createdBy: String(doc.createdBy),
    createdAt: isoRequired(ts.createdAt),
    lastMessageAt: iso(doc.lastMessageAt),
  };
}

export function serializeMessage(doc: MessageDoc): Message {
  const ts = doc as unknown as Timestamped;
  const authorKind = doc.authorKind as 'user' | 'agent' | 'system';
  const author =
    authorKind === 'user'
      ? ({ kind: 'user' as const, userId: String(doc.authorUserId) })
      : authorKind === 'agent'
        ? ({ kind: 'agent' as const, agentSessionId: String(doc.agentSessionId) })
        : ({ kind: 'system' as const });

  return {
    id: String(doc._id),
    conversationId: String(doc.conversationId),
    kind: doc.kind as Message['kind'],
    author,
    blocks: (doc.blocks ?? []) as MessageBlock[],
    mentions: (doc.mentions ?? []).map(String),
    agentSessionId: doc.agentSessionId ? String(doc.agentSessionId) : null,
    question: (doc.question ?? null) as Message['question'],
    createdAt: isoRequired(ts.createdAt),
    editedAt: iso(doc.editedAt),
  };
}

export function serializeAgentSession(doc: AgentSessionDoc): AgentSession {
  const ts = doc as unknown as Timestamped;
  return {
    id: String(doc._id),
    conversationId: String(doc.conversationId),
    harness: doc.harness as AgentSession['harness'],
    title: doc.title,
    status: doc.status as AgentSession['status'],
    repositories: (doc.repositories ?? []).map((r) => ({
      repositoryId: String(r.repositoryId),
      name: r.name,
      url: r.url,
      sandboxPath: r.sandboxPath,
      cloned: Boolean(r.cloned),
      cloneError: r.cloneError ?? null,
    })),
    createdBy: String(doc.createdBy),
    createdAt: isoRequired(ts.createdAt),
    updatedAt: isoRequired(ts.updatedAt),
    harnessSessionId: doc.harnessSessionId ?? null,
    sandboxPath: doc.sandboxPath ?? null,
    lastError: doc.lastError ?? null,
    turnCount: doc.turnCount ?? 0,
  };
}

export function serializeAgentEvent(doc: AgentEventDoc): AgentEvent {
  const ts = doc as unknown as { createdAt: Date };
  return {
    id: String(doc._id),
    agentSessionId: String(doc.agentSessionId),
    seq: doc.seq,
    type: doc.type as AgentEvent['type'],
    summary: doc.summary,
    detail: doc.detail ?? null,
    data: (doc.data ?? null) as Record<string, unknown> | null,
    createdAt: isoRequired(ts.createdAt),
  };
}

export function serializeCredential(doc: CredentialDoc): CredentialSummary {
  const ts = doc as unknown as Timestamped;
  return {
    id: String(doc._id),
    name: doc.name,
    type: doc.type as CredentialSummary['type'],
    username: doc.username ?? null,
    createdBy: String(doc.createdBy),
    createdAt: isoRequired(ts.createdAt),
  };
}

export function serializeRepository(
  doc: RepositoryDoc,
  credentialName: string | null = null,
): Repository {
  const ts = doc as unknown as Timestamped;
  return {
    id: String(doc._id),
    name: doc.name,
    url: doc.url,
    protocol: doc.protocol as 'https' | 'ssh',
    credentialId: doc.credentialId ? String(doc.credentialId) : null,
    credentialName,
    defaultBranch: doc.defaultBranch ?? null,
    createdBy: String(doc.createdBy),
    createdAt: isoRequired(ts.createdAt),
  };
}

export function serializeFile(doc: FileDoc): UploadedFile {
  return {
    id: String(doc._id),
    filename: doc.filename,
    mimeType: doc.mimeType,
    size: doc.size,
    isImage: Boolean(doc.isImage),
    width: doc.width ?? undefined,
    height: doc.height ?? undefined,
    url: `/api/files/${String(doc._id)}`,
  };
}
