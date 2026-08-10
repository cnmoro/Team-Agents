import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { QuestionOption } from '@teamagents/shared';
import { spawnInSandbox, SANDBOX_WORK } from '../../sandbox/sandboxManager.js';
import { NdjsonReader, ndjsonLine, summarize } from '../ndjson.js';
import { terminateChild } from '../processUtils.js';
import { CHAT_GUIDANCE, type AdapterContext, type HarnessAdapter, type HarnessRunner } from '../types.js';

/**
 * Claude Code adapter.
 *
 * Runs one long-lived `claude -p` process per agent session with
 * `--input-format stream-json`, so stdin stays open and each follow-up prompt is
 * another turn on the same conversation rather than a fresh process. The
 * session id is minted here and passed with `--session-id`, which removes any
 * race around discovering it and lets a restarted server resume with
 * `--resume`.
 *
 * Permission asks arrive over the same stdout channel via
 * `--permission-prompt-tool stdio`. Ordinary tool permissions are granted
 * automatically — the sandbox is the real boundary — but anything the CLI flags
 * as `requires_user_interaction` (notably `AskUserQuestion`) is forwarded into
 * the chat for a human to answer.
 */

interface ControlRequestFrame {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: string;
    tool_name?: string;
    display_name?: string;
    description?: string;
    title?: string;
    input?: Record<string, unknown>;
    requires_user_interaction?: boolean;
    tool_use_id?: string;
    dialog_kind?: string;
  };
}

interface AskUserQuestionInput {
  questions?: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
}

const TURN_IDLE_TIMEOUT_MS = 45 * 60 * 1000;

class ClaudeCodeRunner implements HarnessRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string;
  private turnResolve: (() => void) | null = null;
  private turnReject: ((error: Error) => void) | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** Text accumulated during the current turn, flushed to chat as it arrives. */
  private pendingText = '';
  /**
   * `spawnInSandbox()` in `startProcess()` is genuinely async (real process
   * creation, not instant), so there is a real window — between a turn
   * starting and `this.child` actually being assigned — during which
   * `abort()` would otherwise be a silent no-op (its `if (!this.child)
   * return` guard). A Stop click landing in that window must not be
   * dropped: it is recorded here and acted on the moment the prompt for
   * this turn has actually been sent, so the interrupt has a live turn to
   * cancel.
   */
  private pendingAbort = false;

  constructor(private readonly ctx: AdapterContext) {
    this.sessionId = ctx.harnessSessionId ?? randomUUID();
  }

  isAlive(): boolean {
    return Boolean(this.child) && !this.child!.killed && !this.disposed;
  }

  async runTurn(prompt: string): Promise<void> {
    if (!this.isAlive()) await this.startProcess();
    const child = this.child;
    if (!child) throw new Error('Claude Code process failed to start');

    const turn = new Promise<void>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });
    this.armIdleTimer();

    child.stdin.write(
      ndjsonLine({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      }),
    );

    // A Stop click that arrived while the process was still spawning is
    // recorded on `pendingAbort` (see its declaration) rather than dropped;
    // the prompt above has now been sent, so the interrupt has a real turn
    // to cancel.
    if (this.pendingAbort) {
      this.pendingAbort = false;
      this.sendInterrupt();
    }

    try {
      await turn;
    } finally {
      this.clearIdleTimer();
      await this.flushText();
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.turnTimer = setTimeout(() => {
      this.failTurn(new Error('Claude Code produced no output for 45 minutes; the turn was abandoned'));
    }, TURN_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  private async startProcess(): Promise<void> {
    const { ctx } = this;
    const resuming = Boolean(ctx.harnessSessionId);

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      // Mandatory companion of stream-json output; without it the CLI errors.
      '--verbose',
      // Routes permission asks to us instead of failing closed.
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'acceptEdits',
      '--append-system-prompt', CHAT_GUIDANCE,
    ];

    if (resuming) args.push('--resume', this.sessionId);
    else args.push('--session-id', this.sessionId);

    // Repositories live side by side under /work; the process starts there and
    // each clone is registered so reads outside the cwd are permitted.
    for (const repoPath of ctx.repoPaths) args.push('--add-dir', repoPath);

    await ctx.emit({
      type: 'status',
      summary: resuming ? 'Resuming Claude Code session' : 'Starting Claude Code',
      detail: `claude ${args.map(quoteArg).join(' ')}`,
      data: { sessionId: this.sessionId, resuming },
    });

    const child = await spawnInSandbox(ctx.sandbox, ctx.install, {
      command: ctx.install.binPath,
      args,
      cwd: ctx.repoPaths[0] ?? SANDBOX_WORK,
      env: {
        // Keeps the CLI from believing it is nested inside another Claude Code
        // run when the server itself was started from one.
        CLAUDECODE: '',
        CLAUDE_CODE_CHILD_SESSION: '',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
    });
    this.child = child;
    await this.ctx.rememberSessionId(this.sessionId);

    const reader = new NdjsonReader(
      (value) => void this.onEvent(value as Record<string, unknown>),
      (line) => {
        void this.ctx.emit({ type: 'raw', summary: summarize(line), detail: line });
      },
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => reader.push(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) void this.ctx.emit({ type: 'warning', summary: summarize(text), detail: text });
    });

    child.on('error', (error) => this.failTurn(error));
    // `child.stdin` is its own stream and can emit 'error' independently of
    // the child process's own 'error' event — most commonly EPIPE, when
    // something writes (a turn's prompt, an abort's interrupt request) after
    // the process has already exited, e.g. a session closed concurrently
    // with a turn starting. A plain child-only listener does not catch that:
    // an unhandled 'error' event on a stream is a fatal, uncaught exception
    // that crashes the whole server process, taking down every other agent
    // session with it. Route it through the same failure path instead.
    child.stdin.on('error', (error) => this.failTurn(error));
    child.on('close', (code) => {
      reader.end();
      this.child = null;
      // A close during a turn means the harness died; a close between turns is
      // normal after dispose().
      this.failTurn(new Error(`Claude Code exited with code ${code ?? 'unknown'}`));
    });
  }

  private async onEvent(event: Record<string, unknown>): Promise<void> {
    this.armIdleTimer();
    const type = event.type as string | undefined;

    if (typeof event.session_id === 'string' && event.session_id !== this.sessionId) {
      // The CLI is authoritative about its own id; adopt whatever it reports.
      this.sessionId = event.session_id;
      await this.ctx.rememberSessionId(this.sessionId);
    }

    switch (type) {
      case 'control_request':
        await this.onControlRequest(event as unknown as ControlRequestFrame);
        return;

      case 'system': {
        const subtype = event.subtype as string | undefined;
        if (subtype === 'init') {
          await this.ctx.emit({
            type: 'status',
            summary: `Session ready (model ${String((event as { model?: string }).model ?? 'unknown')})`,
            data: { tools: event.tools, model: event.model, permissionMode: event.permissionMode },
          });
        }
        return;
      }

      case 'assistant': {
        const message = event.message as { content?: unknown[] } | undefined;
        for (const block of message?.content ?? []) {
          const entry = block as { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string };
          if (entry.type === 'text' && entry.text) {
            this.pendingText += entry.text;
            await this.ctx.emit({ type: 'assistant_text', summary: summarize(entry.text), detail: entry.text });
          } else if (entry.type === 'thinking' && entry.thinking) {
            // Reasoning is recorded in the trace but never posted to the chat.
            await this.ctx.emit({
              type: 'reasoning',
              summary: summarize(entry.thinking),
              detail: entry.thinking,
            });
          } else if (entry.type === 'tool_use') {
            await this.ctx.emit({
              type: 'tool_use',
              summary: `${entry.name ?? 'tool'}: ${summarize(describeToolInput(entry.input))}`,
              detail: JSON.stringify(entry.input, null, 2),
              data: { tool: entry.name, toolUseId: entry.id },
            });
          }
        }
        return;
      }

      case 'user': {
        if (event.isReplay) return;
        const message = event.message as { content?: unknown } | undefined;
        const content = Array.isArray(message?.content) ? message?.content : [];
        for (const block of content) {
          const entry = block as { type?: string; content?: unknown; is_error?: boolean; tool_use_id?: string };
          if (entry.type !== 'tool_result') continue;
          const text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
          await this.ctx.emit({
            type: 'tool_result',
            summary: `${entry.is_error ? 'failed' : 'ok'}: ${summarize(text ?? '')}`,
            detail: text ?? null,
            data: { toolUseId: entry.tool_use_id, isError: entry.is_error === true },
          });
        }
        return;
      }

      case 'result': {
        const isError = event.is_error === true;
        const text = typeof event.result === 'string' ? event.result : '';
        await this.flushText();
        // An auth failure arrives as a *successful* result whose text is the
        // error, so the text is inspected rather than only the flags.
        if (isError || /^Not logged in/i.test(text)) {
          await this.ctx.emit({
            type: 'error',
            summary: summarize(text || String(event.subtype ?? 'run failed')),
            detail: text || null,
            data: { subtype: event.subtype, apiErrorStatus: event.api_error_status },
          });
          if (text) await this.ctx.say(text);
          this.completeTurn(new Error(text || 'Claude Code reported an error'));
          return;
        }
        await this.ctx.emit({
          type: 'turn_complete',
          summary: `Turn complete${event.total_cost_usd ? ` — $${Number(event.total_cost_usd).toFixed(4)}` : ''}`,
          data: { usage: event.usage, costUsd: event.total_cost_usd, numTurns: event.num_turns },
        });
        this.completeTurn();
        return;
      }

      default:
        // stream_event, rate_limit_event, and anything new: recorded so the
        // trace stays complete, but not surfaced in the chat.
        if (type !== 'stream_event') {
          await this.ctx.emit({
            type: 'raw',
            summary: summarize(`${type ?? 'event'}`),
            detail: JSON.stringify(event, null, 2),
          });
        }
    }
  }

  private async onControlRequest(frame: ControlRequestFrame): Promise<void> {
    const { request_id: requestId, request } = frame;
    if (request.subtype !== 'can_use_tool') {
      // Unknown dialog kinds must be answered or the turn blocks forever.
      this.respond(requestId, { behavior: 'cancelled' });
      await this.ctx.emit({
        type: 'warning',
        summary: `Declined unsupported control request "${request.subtype}"`,
        detail: JSON.stringify(frame, null, 2),
      });
      return;
    }

    if (!request.requires_user_interaction) {
      // The sandbox already constrains what the agent can touch, so tool
      // permissions are granted without interrupting the humans.
      this.respond(requestId, { behavior: 'allow', updatedInput: request.input ?? {} });
      return;
    }

    const { question, options, allowFreeText } = buildQuestion(request);
    await this.ctx.emit({
      type: 'question',
      summary: summarize(question),
      detail: JSON.stringify(request.input, null, 2),
      data: { tool: request.tool_name },
    });

    try {
      const answer = await this.ctx.ask({
        question,
        options,
        allowFreeText,
        data: { tool: request.tool_name, toolUseId: request.tool_use_id },
      });
      // Verified behaviour: `allow` with injected answers is ignored by the
      // model, while a denial message is delivered verbatim. The error flag it
      // sets is cosmetic.
      this.respond(requestId, { behavior: 'deny', message: answer });
    } catch (error) {
      this.respond(requestId, {
        behavior: 'deny',
        message: `The user did not answer: ${(error as Error).message}`,
      });
    }
  }

  private respond(requestId: string, response: Record<string, unknown>): void {
    this.child?.stdin.write(
      ndjsonLine({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      }),
    );
  }

  private async flushText(): Promise<void> {
    const text = this.pendingText.trim();
    this.pendingText = '';
    if (text) await this.ctx.say(text);
  }

  private completeTurn(error?: Error): void {
    this.clearIdleTimer();
    const resolve = this.turnResolve;
    const reject = this.turnReject;
    this.turnResolve = null;
    this.turnReject = null;
    if (error) reject?.(error);
    else resolve?.();
  }

  private failTurn(error: Error): void {
    if (!this.turnReject) return;
    this.completeTurn(error);
  }

  async abort(): Promise<void> {
    if (!this.child) {
      this.pendingAbort = true;
      return;
    }
    this.sendInterrupt();
  }

  private sendInterrupt(): void {
    this.child?.stdin.write(
      ndjsonLine({
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'interrupt', cancel_queued: true },
      }),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    // SIGTERM runs the CLI's shutdown hooks; escalate only if it hangs.
    await terminateChild(child);
  }
}

/** Converts an AskUserQuestion payload into a chat question. */
function buildQuestion(request: ControlRequestFrame['request']): {
  question: string;
  options: QuestionOption[];
  allowFreeText: boolean;
} {
  const input = (request.input ?? {}) as AskUserQuestionInput;
  const questions = input.questions ?? [];
  const first = questions[0];

  if (!first) {
    return {
      question: request.title ?? request.description ?? `${request.tool_name ?? 'The agent'} needs your input`,
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
      allowFreeText: true,
    };
  }

  const extra = questions.slice(1);
  const questionText = extra.length
    ? `${first.question}\n\nAlso: ${extra.map((q) => q.question).join(' ')}`
    : first.question;

  return {
    question: questionText,
    options: (first.options ?? []).map((option, index) => ({
      id: `opt-${index}`,
      label: option.label,
      description: option.description,
    })),
    allowFreeText: true,
  };
}

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return JSON.stringify(record);
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: 'claude-code',
  guidance: CHAT_GUIDANCE,
  createRunner: (context) => new ClaudeCodeRunner(context),
};
