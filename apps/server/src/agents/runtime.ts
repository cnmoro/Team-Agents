import { randomUUID } from 'node:crypto';
import type { AgentQuestionPayload, AgentSessionStatus } from '@teamagents/shared';
import { AgentEventModel } from '../models/agentEvent.js';
import { AgentSessionModel, type AgentSessionDoc } from '../models/agentSession.js';
import { hub } from '../realtime/hub.js';
import { createMessage, updateMessage } from '../services/messageService.js';
import { serializeAgentEvent, serializeAgentSession } from '../services/serialize.js';
import { describeSandbox } from '../sandbox/sandboxManager.js';
import { resolveHarness, type HarnessInstall } from './harnessRegistry.js';
import { claudeCodeAdapter } from './adapters/claudeCode.js';
import { codexAdapter } from './adapters/codex.js';
import { opencodeAdapter } from './adapters/opencode.js';
import type { AdapterContext, AskRequest, EmittedEvent, HarnessAdapter, HarnessRunner } from './types.js';

const ADAPTERS: Record<string, HarnessAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

interface PendingQuestion {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  messageId: string;
  payload: AgentQuestionPayload;
}

interface LiveSession {
  runner: HarnessRunner;
  /** Serializes turns: a harness handles one prompt at a time. */
  queue: Promise<void>;
  questions: Map<string, PendingQuestion>;
  /**
   * Set by `abort()` just before asking the runner to stop, and read by the
   * turn currently in flight so it can tell "the user clicked Stop" apart
   * from "the harness genuinely failed" — the two look identical to the
   * runner (both surface as the in-flight promise rejecting), so without this
   * flag a deliberate stop renders in the UI as a scary "Failed" status and,
   * on a first turn, a chat message claiming the agent "could not start".
   */
  aborted: boolean;
}

/** Thrown when a turn ends because a human clicked Stop, not because the harness failed. */
export class UserAbortError extends Error {
  constructor() {
    super('The run was stopped before it finished.');
    this.name = 'UserAbortError';
  }
}

/**
 * Owns every running agent for the lifetime of the server process.
 *
 * Sandboxes and harness session ids are persistent, so a restart loses only the
 * in-memory runner: the next prompt reconnects to the same sandbox and resumes
 * the same harness conversation. Questions outstanding at shutdown are the one
 * casualty, and they are explicitly cancelled so nobody is left staring at a
 * prompt nothing will ever answer.
 */
class AgentRuntime {
  private readonly sessions = new Map<string, LiveSession>();

  isRunning(agentSessionId: string): boolean {
    return this.sessions.has(agentSessionId);
  }

  /** Records a trace event and streams it to everyone watching. */
  async emit(session: AgentSessionDoc, event: EmittedEvent): Promise<void> {
    // The counter lives on the session document so sequence numbers survive a
    // restart and the trace never renumbers.
    const updated = await AgentSessionModel.findByIdAndUpdate(
      session._id,
      { $inc: { eventSeq: 1 } },
      { new: true },
    );
    const seq = updated?.eventSeq ?? 0;

    const doc = await AgentEventModel.create({
      agentSessionId: session._id,
      seq,
      type: event.type,
      summary: event.summary.slice(0, 2000),
      detail: event.detail ? event.detail.slice(0, 200_000) : null,
      data: event.data ?? null,
    });

    hub.emitAgentEvent(String(session.conversationId), serializeAgentEvent(doc));
  }

  /**
   * Closing a session is meant to be terminal: `closeAgent()` erases the
   * sandbox and marks it 'closed', and the settings panel tells the user
   * that's permanent. But provisioning and a harness turn both run in the
   * background and can still be mid-flight when a close lands — their own
   * `catch` blocks then call `setStatus(..., 'error')` on a session that was
   * *just* closed, and a plain `session.save()` here would win that race and
   * silently resurrect it: sandbox gone, status flipped back to non-closed,
   * with nothing in the UI to explain it. The filtered `findOneAndUpdate`
   * makes the write a no-op once the session is closed, no matter how stale
   * the in-memory `session` passed in is.
   */
  async setStatus(
    session: AgentSessionDoc,
    status: AgentSessionStatus,
    lastError?: string | null,
  ): Promise<AgentSessionDoc> {
    const update: { status: AgentSessionStatus; lastError?: string | null } = { status };
    if (lastError !== undefined) update.lastError = lastError;
    const updated = await AgentSessionModel.findOneAndUpdate(
      { _id: session._id, status: { $ne: 'closed' } },
      { $set: update },
      { new: true },
    );
    if (!updated) return session;
    session.status = updated.status;
    session.lastError = updated.lastError;
    hub.emitAgentSession(String(session.conversationId), serializeAgentSession(session));
    return session;
  }

  /** Builds the sandboxed view of the world handed to an adapter. */
  private buildContext(
    session: AgentSessionDoc,
    install: HarnessInstall,
    log: AdapterContext['log'],
  ): AdapterContext {
    const agentSessionId = String(session._id);
    const conversationId = String(session.conversationId);

    return {
      agentSessionId,
      conversationId,
      harness: session.harness as AdapterContext['harness'],
      sandbox: describeSandbox(agentSessionId),
      install,
      repoPaths: session.repositories.filter((r) => r.cloned).map((r) => r.sandboxPath),
      harnessSessionId: session.harnessSessionId ?? null,
      log,

      emit: async (event) => {
        const fresh = await AgentSessionModel.findById(agentSessionId);
        if (fresh) await this.emit(fresh, event);
      },

      say: async (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        // A close (sandbox erased, "Session closed" system message already
        // posted) can race a turn that is still mid-flight — e.g. Stop and
        // Close & erase fired at nearly the same moment. Without this check
        // the harness's own in-flight output still lands as a fresh chat
        // bubble after the "closed" message, making an already-terminated
        // session look like it's still doing something.
        const fresh = await AgentSessionModel.findById(agentSessionId).select('status').lean();
        if (!fresh || fresh.status === 'closed') return;
        await createMessage({
          conversationId,
          kind: 'agent_output',
          authorKind: 'agent',
          agentSessionId,
          blocks: parseAgentText(trimmed),
        });
      },

      ask: (request) => this.askQuestion(agentSessionId, conversationId, request),

      rememberSessionId: async (id) => {
        await AgentSessionModel.updateOne(
          { _id: agentSessionId },
          { $set: { harnessSessionId: id } },
        );
      },
    };
  }

  /**
   * Posts a question into the chat and waits for a human. Any member of the
   * conversation may answer; the first answer wins.
   */
  private askQuestion(
    agentSessionId: string,
    conversationId: string,
    request: AskRequest,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      void (async () => {
        const questionId = randomUUID();
        const payload: AgentQuestionPayload = {
          questionId,
          agentSessionId,
          question: request.question,
          options: request.options,
          allowFreeText: request.allowFreeText,
          answeredBy: null,
          answeredAt: null,
          answerText: null,
          cancelled: false,
        };

        const message = await createMessage({
          conversationId,
          kind: 'agent_question',
          authorKind: 'agent',
          agentSessionId,
          blocks: [{ type: 'text', text: request.question }],
          question: payload,
        });

        const live = this.sessions.get(agentSessionId);
        if (!live) {
          reject(new Error('The agent session is no longer running'));
          return;
        }
        live.questions.set(questionId, { resolve, reject, messageId: message.id, payload });

        const session = await AgentSessionModel.findById(agentSessionId);
        if (session) await this.setStatus(session, 'waiting_input');
        hub.emitAgentQuestion(conversationId, payload);
      })().catch(reject);
    });
  }

  /** Delivers a human's answer to the waiting adapter. Returns false if unknown. */
  async answerQuestion(
    agentSessionId: string,
    questionId: string,
    answerText: string,
    answeredBy: string,
  ): Promise<boolean> {
    const live = this.sessions.get(agentSessionId);
    const pending = live?.questions.get(questionId);
    if (!live || !pending) return false;
    live.questions.delete(questionId);

    const answeredPayload: AgentQuestionPayload = {
      ...pending.payload,
      answeredBy,
      answeredAt: new Date().toISOString(),
      answerText,
    };
    await updateMessage(pending.messageId, { question: answeredPayload });

    const session = await AgentSessionModel.findById(agentSessionId);
    if (session) {
      await this.emit(session, {
        type: 'question_answered',
        summary: `Answered: ${answerText.slice(0, 120)}`,
        data: { questionId, answeredBy },
      });
      await this.setStatus(session, 'running');
    }

    pending.resolve(answerText);
    return true;
  }

  /** Cancels every outstanding question for a session. */
  private async cancelQuestions(agentSessionId: string, reason: string): Promise<void> {
    const live = this.sessions.get(agentSessionId);
    if (!live) return;
    for (const [questionId, pending] of live.questions) {
      live.questions.delete(questionId);
      await updateMessage(pending.messageId, {
        question: { ...pending.payload, cancelled: true },
      });
      pending.reject(new Error(reason));
    }
  }

  /**
   * Queues a prompt for a session, starting the harness process if it is not
   * already running. Resolves when the turn completes.
   */
  async runTurn(session: AgentSessionDoc, prompt: string, log: AdapterContext['log']): Promise<void> {
    const agentSessionId = String(session._id);
    const adapter = ADAPTERS[session.harness];
    if (!adapter) throw new Error(`Unknown harness "${session.harness}"`);

    let live = this.sessions.get(agentSessionId);
    if (!live) {
      const install = await resolveHarness(session.harness as never);
      if (!install) {
        throw new Error(`The ${session.harness} CLI is not available on this host`);
      }
      const context = this.buildContext(session, install, log);
      live = {
        runner: adapter.createRunner(context),
        queue: Promise.resolve(),
        questions: new Map(),
        aborted: false,
      };
      this.sessions.set(agentSessionId, live);
    }

    const runner = live.runner;
    // Chain onto the queue so two people prompting at once are serialized
    // rather than interleaved into the same harness turn.
    const turn = live.queue.then(async () => {
      const fresh = await AgentSessionModel.findById(agentSessionId);
      if (!fresh || fresh.status === 'closed') throw new Error('The agent session has been closed');
      live!.aborted = false;
      await this.setStatus(fresh, 'running', null);
      try {
        await runner.runTurn(prompt);
        const after = await AgentSessionModel.findById(agentSessionId);
        if (after && after.status !== 'closed') {
          after.turnCount += 1;
          await after.save();
          await this.setStatus(after, 'idle', null);
        }
      } catch (error) {
        const after = await AgentSessionModel.findById(agentSessionId);
        if (live!.aborted) {
          // A human clicked Stop: this is an expected, clean end to the turn,
          // not a failure, so it must not read like one in the UI or chat.
          if (after && after.status !== 'closed') {
            await this.setStatus(after, 'idle', 'The run was stopped before it finished.');
          }
          throw new UserAbortError();
        }
        const message = (error as Error).message;
        if (after && after.status !== 'closed') {
          await this.emit(after, { type: 'error', summary: message, detail: message });
          await this.setStatus(after, 'error', message);
        }
        throw error;
      }
    });

    // The queue must not reject, or every later turn inherits the failure.
    live.queue = turn.catch(() => undefined);
    return turn;
  }

  async abort(agentSessionId: string): Promise<void> {
    const live = this.sessions.get(agentSessionId);
    if (!live) return;
    live.aborted = true;
    await this.cancelQuestions(agentSessionId, 'The run was stopped');
    await live.runner.abort();
  }

  /** Tears down the live process. The sandbox on disk is untouched. */
  async shutdownSession(agentSessionId: string, reason: string): Promise<void> {
    const live = this.sessions.get(agentSessionId);
    if (!live) return;
    await this.cancelQuestions(agentSessionId, reason);
    this.sessions.delete(agentSessionId);
    await live.runner.dispose();
  }

  /** Called on server shutdown: stops every harness process cleanly. */
  async shutdownAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.shutdownSession(id, 'The server is shutting down')));
  }
}

/**
 * Splits agent output into text and fenced code blocks so code arrives in the
 * chat as a real, copyable, highlighted block rather than raw backticks.
 */
export function parseAgentText(text: string): Array<
  { type: 'text'; text: string } | { type: 'code'; language: string; code: string }
> {
  const blocks: Array<{ type: 'text'; text: string } | { type: 'code'; language: string; code: string }> = [];
  const fence = /```([a-zA-Z0-9+#._-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) blocks.push({ type: 'text', text: before });
    const code = match[2] ?? '';
    if (code.trim()) {
      blocks.push({ type: 'code', language: (match[1] || 'plaintext').toLowerCase(), code: code.replace(/\n$/, '') });
    }
    lastIndex = fence.lastIndex;
  }

  const rest = text.slice(lastIndex).trim();
  if (rest) blocks.push({ type: 'text', text: rest });
  return blocks.length > 0 ? blocks : [{ type: 'text', text }];
}

export const runtime = new AgentRuntime();
