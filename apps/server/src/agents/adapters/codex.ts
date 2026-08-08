import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { QuestionOption } from '@teamagents/shared';
import { spawnInSandbox, SANDBOX_WORK } from '../../sandbox/sandboxManager.js';
import { NdjsonReader, ndjsonLine, summarize } from '../ndjson.js';
import { CHAT_GUIDANCE, type AdapterContext, type HarnessAdapter, type HarnessRunner } from '../types.js';

/**
 * Codex adapter, speaking the `codex app-server` JSON-RPC 2.0 protocol over
 * stdio (newline-delimited, no Content-Length framing).
 *
 * `codex exec --json` is deliberately not used: it is one-shot and has no
 * server-to-client channel, so an agent could never ask a question. The
 * app-server surface is what the first-party editor integrations use and is the
 * only one that supports approvals and user-input requests.
 *
 * Codex ships its own OS-level sandbox (landlock/seccomp). Nesting that inside
 * bubblewrap is fragile and redundant, so the thread runs with full access
 * *within the bubblewrap sandbox*, which is the real boundary here.
 */

const SANDBOX_MODE = 'danger-full-access';
const APPROVAL_POLICY = 'on-request';
const TURN_IDLE_TIMEOUT_MS = 45 * 60 * 1000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class CodexRunner implements HarnessRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingCall>();
  private threadId: string | null;
  private currentTurnId: string | null = null;
  private turnResolve: (() => void) | null = null;
  private turnReject: ((error: Error) => void) | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** Streaming assistant text, keyed by item id. */
  private readonly messageBuffers = new Map<string, string>();

  constructor(private readonly ctx: AdapterContext) {
    this.threadId = ctx.harnessSessionId;
  }

  isAlive(): boolean {
    return Boolean(this.child) && !this.disposed;
  }

  async runTurn(prompt: string): Promise<void> {
    if (!this.isAlive()) await this.startProcess();

    const turn = new Promise<void>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });
    this.armIdleTimer();

    try {
      const result = (await this.call('turn/start', {
        threadId: this.threadId,
        // `text_elements` is non-optional in the protocol's text input variant.
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      })) as { turn?: { id?: string } };
      this.currentTurnId = result?.turn?.id ?? null;
      await turn;
    } finally {
      this.clearIdleTimer();
      this.currentTurnId = null;
    }
  }

  private async startProcess(): Promise<void> {
    const { ctx } = this;
    const args = ['app-server', '--stdio'];

    await ctx.emit({
      type: 'status',
      summary: this.threadId ? 'Resuming Codex thread' : 'Starting Codex app-server',
      detail: `codex ${args.join(' ')}`,
      data: { threadId: this.threadId },
    });

    const child = await spawnInSandbox(ctx.sandbox, ctx.install, {
      command: ctx.install.binPath,
      args,
      cwd: ctx.repoPaths[0] ?? SANDBOX_WORK,
      // The server logs freely to stderr; quieting it keeps the trace readable.
      env: { RUST_LOG: 'error' },
    });
    this.child = child;

    const reader = new NdjsonReader(
      (value) => void this.onMessage(value as JsonRpcMessage),
      (line) => void this.ctx.emit({ type: 'raw', summary: summarize(line), detail: line }),
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => reader.push(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      // stderr carries benign `ERROR` lines on every run; they are recorded but
      // never treated as failures.
      if (text) void this.ctx.emit({ type: 'raw', summary: summarize(text), detail: text });
    });

    child.on('error', (error) => this.failTurn(error));
    child.on('close', (code) => {
      reader.end();
      this.child = null;
      for (const [, call] of this.pending) call.reject(new Error('Codex app-server exited'));
      this.pending.clear();
      this.failTurn(new Error(`Codex app-server exited with code ${code ?? 'unknown'}`));
    });

    await this.call('initialize', {
      clientInfo: { name: 'teamagents', title: 'TeamAgents', version: '0.1.0' },
      // `item/tool/requestUserInput` — the channel for real questions — is
      // gated behind the experimental capability.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', undefined);

    if (this.threadId) {
      await this.call('thread/resume', { threadId: this.threadId, cwd: this.workingDirectory() });
    } else {
      const started = (await this.call('thread/start', {
        cwd: this.workingDirectory(),
        approvalPolicy: APPROVAL_POLICY,
        sandbox: SANDBOX_MODE,
        developerInstructions: CHAT_GUIDANCE,
      })) as { thread?: { id?: string } };
      this.threadId = started?.thread?.id ?? null;
      if (!this.threadId) throw new Error('Codex did not return a thread id');
      await this.ctx.rememberSessionId(this.threadId);
    }
  }

  private workingDirectory(): string {
    return this.ctx.repoPaths[0] ?? SANDBOX_WORK;
  }

  // --- JSON-RPC plumbing ---------------------------------------------------

  private call(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(ndjsonLine({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(ndjsonLine({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }));
  }

  private respond(id: number | string, result: unknown): void {
    this.child?.stdin.write(ndjsonLine({ jsonrpc: '2.0', id, result }));
  }

  private async onMessage(message: JsonRpcMessage): Promise<void> {
    this.armIdleTimer();

    // A response to something we sent.
    if (message.id !== undefined && message.method === undefined) {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message ?? 'Codex request failed'));
      else call.resolve(message.result);
      return;
    }

    // A request from the server: it blocks the turn until answered.
    if (message.id !== undefined && message.method) {
      await this.onServerRequest(message.id, message.method, message.params ?? {});
      return;
    }

    if (message.method) await this.onNotification(message.method, message.params ?? {});
  }

  private async onServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        // The bubblewrap sandbox is the boundary that matters, so escalations
        // are granted automatically and recorded rather than interrupting the
        // conversation. The decision list is read from the request because it
        // varies per prompt.
        const decisions = (params.availableDecisions as unknown[]) ?? ['accept'];
        const accept = decisions.find((d) => d === 'accept') ?? decisions[0] ?? 'accept';
        await this.ctx.emit({
          type: 'status',
          summary: `Auto-approved: ${summarize(String(params.command ?? params.reason ?? method))}`,
          detail: JSON.stringify(params, null, 2),
        });
        this.respond(id, { decision: accept });
        return;
      }

      case 'item/permissions/requestApproval': {
        this.respond(id, { permissions: params.permissions ?? {}, scope: 'session' });
        return;
      }

      case 'item/tool/requestUserInput': {
        await this.handleUserInput(id, params);
        return;
      }

      case 'currentTime/read': {
        this.respond(id, { currentTime: new Date().toISOString() });
        return;
      }

      default:
        // Every server request must be answered; an unanswered one stalls the
        // turn forever.
        await this.ctx.emit({
          type: 'warning',
          summary: `Declined unsupported request "${method}"`,
          detail: JSON.stringify(params, null, 2),
        });
        this.respond(id, { decision: 'cancel' });
    }
  }

  /** Turns Codex's structured question payload into chat questions. */
  private async handleUserInput(id: number | string, params: Record<string, unknown>): Promise<void> {
    const questions = (params.questions as Array<{
      id: string;
      header?: string;
      question: string;
      isOther?: boolean;
      isSecret?: boolean;
      options?: Array<{ label?: string; value?: string; description?: string }> | null;
    }>) ?? [];

    const answers: Record<string, { answers: string[] }> = {};

    for (const question of questions) {
      const options: QuestionOption[] = (question.options ?? []).map((option, index) => ({
        id: option.value ?? `opt-${index}`,
        label: option.label ?? option.value ?? `Option ${index + 1}`,
        description: option.description,
      }));

      await this.ctx.emit({
        type: 'question',
        summary: summarize(question.question),
        data: { questionId: question.id, secret: question.isSecret === true },
      });

      try {
        const answer = await this.ctx.ask({
          question: question.header ? `${question.header}: ${question.question}` : question.question,
          options,
          allowFreeText: question.isOther !== false,
          data: { questionId: question.id },
        });
        answers[question.id] = { answers: [answer] };
      } catch (error) {
        await this.ctx.emit({
          type: 'warning',
          summary: `Question went unanswered: ${(error as Error).message}`,
        });
        answers[question.id] = { answers: [] };
      }
    }

    this.respond(id, { answers });
  }

  private async onNotification(method: string, params: Record<string, unknown>): Promise<void> {
    switch (method) {
      case 'item/agentMessage/delta': {
        const itemId = String(params.itemId ?? '');
        const delta = String(params.delta ?? '');
        this.messageBuffers.set(itemId, (this.messageBuffers.get(itemId) ?? '') + delta);
        return;
      }

      case 'item/started':
      case 'item/completed': {
        await this.onItem(method, params);
        return;
      }

      case 'turn/completed': {
        const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
        this.messageBuffers.clear();
        if (turn?.status === 'failed') {
          const message = turn.error?.message ?? 'The Codex turn failed';
          await this.ctx.emit({ type: 'error', summary: summarize(message), detail: message });
          await this.ctx.say(message);
          this.completeTurn(new Error(message));
          return;
        }
        await this.ctx.emit({
          type: 'turn_complete',
          summary: `Turn ${turn?.status ?? 'completed'}`,
          data: { status: turn?.status },
        });
        this.completeTurn();
        return;
      }

      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as { total?: Record<string, number> } | undefined;
        await this.ctx.emit({
          type: 'status',
          summary: `Tokens: ${usage?.total?.totalTokens ?? 0}`,
          data: { usage: usage?.total ?? null },
        });
        return;
      }

      case 'error': {
        const message = String(params.message ?? 'Codex reported an error');
        await this.ctx.emit({ type: 'error', summary: summarize(message), detail: message });
        this.failTurn(new Error(message));
        return;
      }

      case 'warning':
      case 'configWarning':
      case 'guardianWarning': {
        const message = String(params.message ?? method);
        await this.ctx.emit({ type: 'warning', summary: summarize(message), detail: message });
        return;
      }

      case 'turn/started': {
        this.currentTurnId = String((params.turn as { id?: string } | undefined)?.id ?? '') || null;
        await this.ctx.emit({ type: 'status', summary: 'Turn started' });
        return;
      }

      // High-volume streaming notifications that the trace does not need.
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'thread/status/changed':
      case 'turn/diff/updated':
        return;

      default:
        await this.ctx.emit({
          type: 'raw',
          summary: method,
          detail: JSON.stringify(params, null, 2),
        });
    }
  }

  private async onItem(method: string, params: Record<string, unknown>): Promise<void> {
    const item = params.item as Record<string, unknown> | undefined;
    if (!item) return;
    const type = String(item.type ?? '');
    const completed = method === 'item/completed';

    switch (type) {
      case 'agentMessage': {
        if (!completed) return;
        const itemId = String(item.id ?? '');
        const text = String(item.text ?? this.messageBuffers.get(itemId) ?? '');
        this.messageBuffers.delete(itemId);
        if (!text.trim()) return;
        await this.ctx.emit({ type: 'assistant_text', summary: summarize(text), detail: text });
        // `commentary` is in-progress narration; only the final answer is
        // posted to the chat so the conversation does not fill with chatter.
        if (item.phase !== 'commentary') await this.ctx.say(text);
        return;
      }

      case 'commandExecution': {
        const command = String(item.command ?? '');
        if (completed) {
          const exitCode = item.exitCode;
          await this.ctx.emit({
            type: 'tool_result',
            summary: `exit ${exitCode ?? '?'}: ${summarize(command)}`,
            detail: String(item.aggregatedOutput ?? ''),
            data: { exitCode },
          });
        } else {
          await this.ctx.emit({
            type: 'tool_use',
            summary: `run: ${summarize(command)}`,
            detail: command,
            data: { cwd: item.cwd },
          });
        }
        return;
      }

      case 'fileChange': {
        if (!completed) return;
        const changes = (item.changes as Array<{ path?: string; kind?: { type?: string } }>) ?? [];
        await this.ctx.emit({
          type: 'tool_use',
          summary: `edit: ${changes.map((c) => c.path ?? '?').join(', ')}`,
          detail: JSON.stringify(changes, null, 2),
        });
        return;
      }

      case 'mcpToolCall': {
        await this.ctx.emit({
          type: completed ? 'tool_result' : 'tool_use',
          summary: `mcp: ${summarize(JSON.stringify(item))}`,
          detail: JSON.stringify(item, null, 2),
        });
        return;
      }

      default:
        return;
    }
  }

  // --- turn lifecycle ------------------------------------------------------

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.turnTimer = setTimeout(() => {
      this.failTurn(new Error('Codex produced no output for 45 minutes; the turn was abandoned'));
    }, TURN_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
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
    if (!this.child || !this.threadId || !this.currentTurnId) return;
    await this.call('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.currentTurnId,
    }).catch(() => {});
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  guidance: CHAT_GUIDANCE,
  createRunner: (context) => new CodexRunner(context),
};
