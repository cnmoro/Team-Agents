/** Agent harnesses, git credentials, sandboxes, and the normalized trace stream. */

export const HARNESSES = ['claude-code', 'codex', 'opencode'] as const;
export type HarnessId = (typeof HARNESSES)[number];

export const HARNESS_LABELS: Record<HarnessId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Reported by the server so the UI can grey out harnesses that aren't installed. */
export interface HarnessAvailability {
  id: HarnessId;
  label: string;
  available: boolean;
  version: string | null;
  /** Why it is unavailable, shown as a tooltip. */
  reason: string | null;
}

// --- Git credentials & repositories ----------------------------------------

export type CredentialType = 'https_token' | 'ssh_key';

/** Credentials are never returned with their secret material after creation. */
export interface CredentialSummary {
  id: string;
  name: string;
  type: CredentialType;
  /** For https_token: the username the token belongs to. */
  username: string | null;
  createdBy: string;
  createdAt: string;
}

export interface CreateCredentialInput {
  name: string;
  type: CredentialType;
  /** https_token: git username (often the account name or `x-access-token`). */
  username?: string;
  /** https_token: personal access token. */
  token?: string;
  /** ssh_key: PEM-encoded private key. */
  privateKey?: string;
  /** ssh_key: passphrase protecting the key, if any. */
  passphrase?: string;
}

export interface Repository {
  id: string;
  name: string;
  url: string;
  protocol: 'https' | 'ssh';
  credentialId: string | null;
  credentialName: string | null;
  defaultBranch: string | null;
  createdBy: string;
  createdAt: string;
}

export interface CreateRepositoryInput {
  name: string;
  url: string;
  credentialId?: string | null;
  defaultBranch?: string | null;
}

// --- Agent sessions ---------------------------------------------------------

export type AgentSessionStatus =
  /** Sandbox is being provisioned and repositories cloned. */
  | 'provisioning'
  /** Harness process is working on a turn. */
  | 'running'
  /** Blocked on a question or permission decision from a human. */
  | 'waiting_input'
  /** Alive and idle: sandbox retained, ready for a follow-up prompt. */
  | 'idle'
  /** Last turn failed. Sandbox is retained so the user can retry. */
  | 'error'
  /** Sandbox destroyed, session archived. */
  | 'closed';

export interface AgentRepoRef {
  repositoryId: string;
  name: string;
  url: string;
  /** Path inside the sandbox, e.g. `/work/my-repo`. */
  sandboxPath: string;
  cloned: boolean;
  cloneError: string | null;
}

export interface AgentSession {
  id: string;
  conversationId: string;
  harness: HarnessId;
  title: string;
  status: AgentSessionStatus;
  repositories: AgentRepoRef[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Session id assigned by the harness itself, used to resume. */
  harnessSessionId: string | null;
  /** Absolute path on the host; shown to the user for transparency. */
  sandboxPath: string | null;
  /** Human-readable summary of the last failure, if any. */
  lastError: string | null;
  /** Number of prompts run in this session. */
  turnCount: number;
}

/** Everything needed to start a new agent session from the composer. */
export interface StartAgentInput {
  conversationId: string;
  harness: HarnessId;
  repositoryIds: string[];
  prompt: string;
  /** Ids of chat messages to serialize into the agent's opening context. */
  contextMessageIds?: string[];
  /** Optional display title; defaults to a truncation of the prompt. */
  title?: string;
}

export interface PromptAgentInput {
  prompt: string;
  contextMessageIds?: string[];
}

// --- Normalized trace events ------------------------------------------------

export type AgentEventType =
  /** Lifecycle: provisioning, cloning, spawning, turn start/end. */
  | 'status'
  /** Assistant narrative text (may arrive in chunks). */
  | 'assistant_text'
  /** Agent's internal reasoning, when the harness exposes it. */
  | 'reasoning'
  /** A tool/command the agent invoked. */
  | 'tool_use'
  /** The result of a tool invocation. */
  | 'tool_result'
  /** The agent needs a human decision. */
  | 'question'
  /** A question was answered (by whom, with what). */
  | 'question_answered'
  /** Non-fatal warning. */
  | 'warning'
  /** Fatal error for the turn. */
  | 'error'
  /** Turn finished. */
  | 'turn_complete'
  /** Raw, unrecognized harness payload — kept so nothing is silently dropped. */
  | 'raw';

export interface AgentEvent {
  id: string;
  agentSessionId: string;
  /** Monotonic per session; the trace view orders and de-duplicates on this. */
  seq: number;
  type: AgentEventType;
  /** One-line summary rendered in the collapsed trace. */
  summary: string;
  /** Full detail, rendered in the expanded trace. */
  detail: string | null;
  /** Structured extras: tool name, exit code, question payload, token usage. */
  data: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * An agent session plus the conversation it belongs to, for the settings screen
 * that lists every session a user can reach — the place to close a session that
 * is holding a repository open.
 */
export interface AgentSessionWithContext extends AgentSession {
  conversationTitle: string;
}

export interface AnswerAgentQuestionInput {
  questionId: string;
  /** Id of the chosen option, or null when answering with free text. */
  optionId?: string | null;
  text?: string | null;
}

/** Reported by `GET /api/system/health` and the settings screen. */
export interface SystemStatus {
  sandboxEnabled: boolean;
  bubblewrap: { available: boolean; version: string | null; reason: string | null };
  harnesses: HarnessAvailability[];
  dataDir: string;
  maxUploadBytes: number;
}
