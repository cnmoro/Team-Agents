import type { AgentEventType, HarnessId, QuestionOption } from '@teamagents/shared';
import type { HarnessInstall } from './harnessRegistry.js';
import type { Sandbox } from '../sandbox/sandboxManager.js';

/** A trace entry an adapter wants recorded and streamed. */
export interface EmittedEvent {
  type: AgentEventType;
  summary: string;
  detail?: string | null;
  data?: Record<string, unknown> | null;
}

/** A question an adapter needs a human to answer before it can continue. */
export interface AskRequest {
  question: string;
  options: QuestionOption[];
  allowFreeText: boolean;
  /** Extra context surfaced in the trace, e.g. the tool being approved. */
  data?: Record<string, unknown>;
}

/**
 * Everything an adapter is allowed to do to the outside world. Adapters never
 * touch the database, sockets, or chat directly — they translate their harness
 * into these calls, which keeps all three integrations interchangeable.
 */
export interface AdapterContext {
  agentSessionId: string;
  conversationId: string;
  harness: HarnessId;
  sandbox: Sandbox;
  install: HarnessInstall;
  /** Paths inside the sandbox for each cloned repository. */
  repoPaths: string[];
  /** Harness-native session id from a previous run, when resuming. */
  harnessSessionId: string | null;

  /** Records a trace event and streams it to the UI. */
  emit(event: EmittedEvent): Promise<void>;
  /** Posts agent narrative into the chat as a message. */
  say(text: string): Promise<void>;
  /**
   * Puts a question into the chat and waits for any member to answer.
   * Resolves with the answer text, or rejects if the session is closed first.
   */
  ask(request: AskRequest): Promise<string>;
  /** Persists the harness's own session id so later turns can resume it. */
  rememberSessionId(id: string): Promise<void>;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/**
 * A live connection to one harness process for one agent session.
 *
 * Implementations own their process lifecycle: `runTurn` may start the process
 * on first use and keep it alive between turns, which is what makes a follow-up
 * prompt cheap and lets the harness retain its own conversation state.
 */
export interface HarnessRunner {
  /** Runs one prompt to completion. Resolves when the harness finishes its turn. */
  runTurn(prompt: string): Promise<void>;
  /** Interrupts the current turn, leaving the session alive. */
  abort(): Promise<void>;
  /** Shuts the process down. The sandbox is untouched. */
  dispose(): Promise<void>;
  isAlive(): boolean;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  createRunner(context: AdapterContext): HarnessRunner;
  /**
   * System prompt appended to every turn, steering the harness toward the
   * behaviour a chat UI needs.
   */
  readonly guidance: string;
}

/** Shared guidance: agents in a chat should ask rather than guess. */
export const CHAT_GUIDANCE = [
  'You are running inside a team chat application. Several people can read your',
  'output and answer you.',
  'When you need a decision, a missing detail, or a choice between approaches,',
  'ask the user directly and end your turn rather than guessing.',
  'Keep your replies concise and readable in a chat window; put code in fenced',
  'code blocks with a language tag.',
].join(' ');
