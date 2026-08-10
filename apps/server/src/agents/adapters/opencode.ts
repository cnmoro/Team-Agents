import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { QuestionOption } from '@teamagents/shared';
import { config } from '../../config.js';
import { spawnInSandbox, SANDBOX_WORK } from '../../sandbox/sandboxManager.js';
import { summarize } from '../ndjson.js';
import { terminateChild } from '../processUtils.js';
import { CHAT_GUIDANCE, type AdapterContext, type HarnessAdapter, type HarnessRunner } from '../types.js';

/**
 * OpenCode adapter.
 *
 * OpenCode exposes an HTTP server rather than a stdio protocol, so this runs
 * `opencode serve` inside the sandbox and talks to it over localhost. The
 * sandbox shares the host network namespace (agents need to reach model
 * providers and git remotes), which is what makes the port reachable from here.
 *
 * The server is unauthenticated by default and exposes shell and PTY endpoints,
 * so a random password is generated per session and Basic auth is required on
 * every request.
 *
 * Two independent human-in-the-loop channels exist: tool *permissions* and the
 * agent's *question* tool. Permissions are auto-granted — bubblewrap is the
 * boundary — while questions are forwarded into the chat.
 */

const STARTUP_TIMEOUT_MS = 90_000;
const TURN_IDLE_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Autonomy inside the sandbox, with the question tool enabled so the agent can
 * still consult the humans. `question: allow` is required for the tool to exist
 * at all.
 */
const PERMISSION_POLICY = {
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  edit: 'allow',
  bash: 'allow',
  task: 'allow',
  skill: 'allow',
  todowrite: 'allow',
  question: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  lsp: 'allow',
  external_directory: 'allow',
  doom_loop: 'ask',
} as const;

/**
 * Builds the sandbox's `opencode.json` from the (optional) config seeded from
 * the operator's own OpenCode install, deliberately narrowed to just the
 * `model` field — see the doc comment on `writeConfig` below for why. Kept as
 * a standalone pure function so this filtering is unit-testable without a
 * live sandbox.
 */
export function buildSandboxOpencodeConfig(
  seededRaw: string | null,
  opencodeModelEnv: string,
): Record<string, unknown> {
  let seededModel: string | undefined;
  if (seededRaw) {
    try {
      const existing = JSON.parse(seededRaw) as Record<string, unknown>;
      if (typeof existing.model === 'string') seededModel = existing.model;
    } catch {
      // Unreadable/invalid seeded config: ignore it, start from scratch.
    }
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    ...(seededModel ? { model: seededModel } : {}),
    ...(opencodeModelEnv ? { model: opencodeModelEnv } : {}),
    permission: PERMISSION_POLICY,
  };
}

interface SseEvent {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
  durable?: { seq?: number };
}

class OpenCodeRunner implements HarnessRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private baseUrl: string | null = null;
  private password: string | null = null;
  private sessionId: string | null;
  private turnResolve: (() => void) | null = null;
  private turnReject: ((error: Error) => void) | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private streamAbort: AbortController | null = null;
  private disposed = false;
  /** Accumulates streamed assistant text per text id. */
  private readonly textBuffers = new Map<string, string>();
  private turnActive = false;
  /**
   * Spawning the server, waiting for it to start listening, and creating a
   * session are all genuinely async, so there is a real window — between a
   * turn starting and the prompt actually being posted — during which
   * `abort()` would otherwise be a silent no-op (its early-return guard). A
   * Stop click landing in that window is recorded here and acted on right
   * after the prompt POST succeeds, so the interrupt has a live turn to
   * target.
   */
  private pendingAbort = false;

  constructor(private readonly ctx: AdapterContext) {
    this.sessionId = ctx.harnessSessionId;
  }

  isAlive(): boolean {
    return Boolean(this.child) && Boolean(this.baseUrl) && !this.disposed;
  }

  async runTurn(prompt: string): Promise<void> {
    if (!this.isAlive()) await this.startProcess();
    if (!this.sessionId) await this.createSession();

    const turn = new Promise<void>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });
    this.turnActive = true;
    this.armIdleTimer();

    try {
      await this.request(`/api/session/${this.sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: { text: prompt }, delivery: 'steer' },
      });

      // A Stop click that arrived before the prompt POST above completed is
      // recorded on `pendingAbort` (see its declaration) rather than
      // dropped; the turn is now live, so the interrupt has something to
      // target.
      if (this.pendingAbort) {
        this.pendingAbort = false;
        await this.sendInterrupt();
      }

      await turn;
    } finally {
      this.turnActive = false;
      this.clearIdleTimer();
    }
  }

  // --- process lifecycle ---------------------------------------------------

  private async startProcess(): Promise<void> {
    const { ctx } = this;
    await this.writeConfig();

    this.password = randomBytes(24).toString('base64url');
    const args = ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'];

    await ctx.emit({
      type: 'status',
      summary: 'Starting OpenCode server',
      detail: `opencode ${args.join(' ')}`,
    });

    const child = await spawnInSandbox(ctx.sandbox, ctx.install, {
      command: ctx.install.binPath,
      args,
      cwd: this.workingDirectory(),
      env: {
        OPENCODE_SERVER_PASSWORD: this.password,
        OPENCODE_SERVER_USERNAME: 'teamagents',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
    });
    this.child = child;

    const url = await this.waitForListening(child);
    this.baseUrl = url;

    child.on('close', (code) => {
      this.child = null;
      this.baseUrl = null;
      this.streamAbort?.abort();
      this.failTurn(new Error(`OpenCode server exited with code ${code ?? 'unknown'}`));
    });

    await ctx.emit({ type: 'status', summary: `OpenCode server ready at ${url}` });
    await this.waitForModelCatalog();
    this.startEventStream();
  }

  /**
   * Blocks until the model catalog has settled.
   *
   * OpenCode loads its provider catalog asynchronously after the HTTP port is
   * already accepting connections. Creating a session in that window resolves
   * the default model against a partial catalog and the first prompt then fails
   * with an opaque upstream 503, while every later prompt succeeds. Waiting for
   * two consecutive identical counts is enough to tell "still loading" from
   * "done".
   */
  private async waitForModelCatalog(): Promise<void> {
    const deadline = Date.now() + 60_000;
    let previous = -1;

    while (Date.now() < deadline) {
      const models = (await this.request('/api/model').catch(() => null)) as
        | { data?: unknown[] }
        | null;
      const count = models?.data?.length ?? 0;

      if (count > 0 && count === previous) {
        await this.ctx.emit({
          type: 'status',
          summary: `Model catalog ready (${count} models)`,
        });
        return;
      }
      previous = count;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    await this.ctx.emit({
      type: 'warning',
      summary: 'Model catalog did not settle within 60s; continuing anyway',
    });
  }

  /** Reads stdout until the server announces the port it bound. */
  private waitForListening(child: ChildProcessWithoutNullStreams): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('OpenCode server did not start within 90 seconds'));
      }, STARTUP_TIMEOUT_MS);

      const inspect = (chunk: string) => {
        buffer += chunk;
        const match = /listening on (https?:\/\/[^\s]+)/i.exec(buffer);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(match[1]!.replace(/\/+$/, ''));
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        inspect(chunk);
        void this.ctx.emit({ type: 'raw', summary: summarize(chunk), detail: chunk });
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        // The port announcement has been seen on stderr in some builds.
        inspect(chunk);
        void this.ctx.emit({ type: 'raw', summary: summarize(chunk), detail: chunk });
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`OpenCode server exited during startup (code ${code ?? 'unknown'})`));
      });
    });
  }

  /**
   * Writes the permission policy and system guidance into the sandbox home.
   *
   * `harnessRegistry.ts` seeds this file wholesale from the operator's own
   * `~/.config/opencode/opencode.json` so the sandbox has *some* config to
   * start from (see its `AUTH_SEEDS` comment). Only the operator's model
   * choice is worth inheriting from it — losing that would leave the agent on
   * whatever default model the CLI picks, which can be one the operator's
   * account has no access to (an opaque upstream 503 on the first prompt).
   * Everything else in that file is the *operator's own machine's* settings,
   * not something that should silently apply to every agent every user of
   * this app runs: third-party `plugin` entries would execute arbitrary code
   * inside every sandbox, and knobs like `compaction.auto` would silently
   * change how every session behaves under a long conversation. This is the
   * same reasoning `AUTH_SEEDS`'s comment already gives for deliberately
   * *not* copying Claude Code's `settings.json` ("would drag their hooks,
   * MCP servers, and CLAUDE.md into every agent run") — it just wasn't
   * applied here yet. `permission` is always overwritten regardless, so it
   * doesn't need this treatment.
   */
  private async writeConfig(): Promise<void> {
    const configDir = path.join(this.ctx.sandbox.homeDir, '.config', 'opencode');
    await mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'opencode.json');

    let seededRaw: string | null = null;
    try {
      seededRaw = await readFile(configPath, 'utf8');
    } catch {
      // No seeded config, or it is unreadable: start from scratch.
    }

    await writeFile(
      configPath,
      JSON.stringify(buildSandboxOpencodeConfig(seededRaw, config.opencodeModel), null, 2),
    );
    // Project-level guidance is the documented way to steer OpenCode's agent.
    const workDir = this.ctx.repoPaths[0]
      ? path.join(this.ctx.sandbox.workDir, path.basename(this.ctx.repoPaths[0]))
      : this.ctx.sandbox.workDir;
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(workDir, 'AGENTS.md'), `# Working agreement\n\n${CHAT_GUIDANCE}\n`).catch(
      () => {
        // A read-only or missing work directory is not fatal.
      },
    );
  }

  private workingDirectory(): string {
    return this.ctx.repoPaths[0] ?? SANDBOX_WORK;
  }

  // --- HTTP ----------------------------------------------------------------

  private async request(
    pathname: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    if (!this.baseUrl) throw new Error('OpenCode server is not running');
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader(),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenCode ${options.method ?? 'GET'} ${pathname} failed: ${response.status} ${text.slice(0, 500)}`);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) return null;
    return response.json();
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`teamagents:${this.password ?? ''}`).toString('base64')}`;
  }

  private async createSession(): Promise<void> {
    const created = (await this.request('/api/session', {
      method: 'POST',
      body: { location: { directory: this.workingDirectory() } },
    })) as { data?: { id?: string; model?: { providerID?: string; id?: string } } } | null;
    const id = created?.data?.id;
    if (!id) throw new Error('OpenCode did not return a session id');
    this.sessionId = id;
    await this.ctx.rememberSessionId(id);

    const model = created?.data?.model;
    await this.ctx.emit({
      type: 'status',
      summary: model ? `Session using ${model.providerID}/${model.id}` : 'Session created',
      data: { sessionId: id, model: model ?? null },
    });
  }

  // --- event stream --------------------------------------------------------

  private startEventStream(): void {
    const controller = new AbortController();
    this.streamAbort = controller;
    void this.consumeEvents(controller).catch((error) => {
      if (controller.signal.aborted) return;
      this.ctx.log.warn({ err: error }, 'OpenCode event stream ended');
      this.failTurn(error as Error);
    });
  }

  private async consumeEvents(controller: AbortController): Promise<void> {
    if (!this.baseUrl) return;
    const response = await fetch(`${this.baseUrl}/api/event`, {
      headers: { Authorization: this.authHeader(), Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.body) throw new Error('OpenCode event stream returned no body');

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.handleFrame(frame);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  private handleFrame(frame: string): void {
    // Frames carry no `event:` line; the type lives inside the JSON payload.
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return;
    try {
      const event = JSON.parse(dataLines.join('\n')) as SseEvent;
      void this.onEvent(event);
    } catch {
      // Heartbeat comments and partial frames are ignored.
    }
  }

  private async onEvent(event: SseEvent): Promise<void> {
    const type = event.type ?? '';
    const data = event.data ?? {};

    // Events for other sessions sharing this server are not ours to handle.
    if (typeof data.sessionID === 'string' && this.sessionId && data.sessionID !== this.sessionId) {
      return;
    }
    if (this.turnActive) this.armIdleTimer();

    switch (type) {
      case 'session.next.text.delta': {
        const textId = String(data.textID ?? '');
        this.textBuffers.set(textId, (this.textBuffers.get(textId) ?? '') + String(data.delta ?? ''));
        return;
      }

      case 'session.next.text.ended': {
        const textId = String(data.textID ?? '');
        const text = String(data.text ?? this.textBuffers.get(textId) ?? '');
        this.textBuffers.delete(textId);
        if (!text.trim()) return;
        await this.ctx.emit({ type: 'assistant_text', summary: summarize(text), detail: text });
        await this.ctx.say(text);
        return;
      }

      case 'session.next.reasoning.ended': {
        const text = String(data.text ?? '');
        if (text.trim()) {
          await this.ctx.emit({ type: 'reasoning', summary: summarize(text), detail: text });
        }
        return;
      }

      case 'session.next.tool.called': {
        await this.ctx.emit({
          type: 'tool_use',
          summary: `${String(data.tool ?? 'tool')}: ${summarize(JSON.stringify(data.input ?? {}))}`,
          detail: JSON.stringify(data.input ?? {}, null, 2),
          data: { tool: data.tool, callId: data.callID },
        });
        return;
      }

      case 'session.next.tool.success':
      case 'session.next.tool.failed': {
        const failed = type.endsWith('failed');
        const content = Array.isArray(data.content)
          ? (data.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
          : '';
        const errorMessage = (data.error as { message?: string } | undefined)?.message;
        await this.ctx.emit({
          type: 'tool_result',
          summary: failed ? `failed: ${summarize(errorMessage ?? '')}` : `ok: ${summarize(content)}`,
          detail: failed ? (errorMessage ?? null) : content || null,
          data: { callId: data.callID, structured: data.structured ?? null },
        });
        return;
      }

      case 'session.next.step.ended': {
        const finish = String(data.finish ?? '');
        // A step that ends on `tool-calls` is followed by another step; only a
        // different finish reason means the turn is genuinely over.
        if (finish && finish !== 'tool-calls') {
          await this.ctx.emit({
            type: 'turn_complete',
            summary: `Turn complete (${finish})`,
            data: { tokens: data.tokens ?? null, cost: data.cost ?? null },
          });
          this.completeTurn();
        }
        return;
      }

      case 'session.next.step.failed':
      case 'session.error': {
        const message =
          (data.error as { message?: string } | undefined)?.message ??
          String(data.message ?? 'OpenCode reported an error');
        await this.ctx.emit({ type: 'error', summary: summarize(message), detail: message });
        await this.ctx.say(message);
        this.failTurn(new Error(message));
        return;
      }

      case 'permission.v2.asked': {
        await this.onPermission(data);
        return;
      }

      case 'question.v2.asked': {
        await this.onQuestion(data);
        return;
      }

      // Streaming noise the trace does not need.
      case 'session.next.reasoning.delta':
      case 'session.next.tool.input.delta':
      case 'session.next.text.started':
      case 'session.next.reasoning.started':
      case 'session.next.tool.input.started':
      case 'session.next.tool.input.ended':
      case 'server.connected':
      case 'server.heartbeat':
        return;

      default:
        if (type.startsWith('session.')) {
          await this.ctx.emit({
            type: 'raw',
            summary: type,
            detail: JSON.stringify(data, null, 2),
          });
        }
    }
  }

  private async onPermission(data: Record<string, unknown>): Promise<void> {
    const requestId = String(data.id ?? '');
    const action = String(data.action ?? 'action');
    const resources = Array.isArray(data.resources) ? (data.resources as string[]) : [];

    await this.ctx.emit({
      type: 'status',
      summary: `Auto-approved ${action}: ${summarize(resources.join(' '))}`,
      detail: JSON.stringify(data, null, 2),
    });
    await this.request(`/api/session/${this.sessionId}/permission/${requestId}/reply`, {
      method: 'POST',
      body: { reply: 'once' },
    }).catch((error: Error) => {
      void this.ctx.emit({ type: 'warning', summary: `Permission reply failed: ${error.message}` });
    });
  }

  private async onQuestion(data: Record<string, unknown>): Promise<void> {
    const requestId = String(data.id ?? '');
    const questions = (data.questions as Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiple?: boolean;
      custom?: boolean;
    }>) ?? [];

    const answers: string[][] = [];

    for (const question of questions) {
      const options: QuestionOption[] = (question.options ?? []).map((option, index) => ({
        // The reply is matched by label, so the label doubles as the id.
        id: option.label ?? `opt-${index}`,
        label: option.label,
        description: option.description,
      }));

      await this.ctx.emit({
        type: 'question',
        summary: summarize(question.question),
        detail: JSON.stringify(question, null, 2),
      });

      try {
        const answer = await this.ctx.ask({
          question: question.header ? `${question.header}: ${question.question}` : question.question,
          options,
          allowFreeText: question.custom !== false,
        });
        answers.push([answer]);
      } catch {
        answers.push([]);
      }
    }

    const unanswered = answers.every((entry) => entry.length === 0);
    const endpoint = unanswered
      ? `/api/session/${this.sessionId}/question/${requestId}/reject`
      : `/api/session/${this.sessionId}/question/${requestId}/reply`;

    await this.request(endpoint, {
      method: 'POST',
      body: unanswered ? undefined : { answers },
    }).catch((error: Error) => {
      void this.ctx.emit({ type: 'warning', summary: `Question reply failed: ${error.message}` });
    });
  }

  // --- turn lifecycle ------------------------------------------------------

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.turnTimer = setTimeout(() => {
      // A model reference the server cannot resolve makes the prompt hang
      // silently with no error event, so a watchdog is the only way out.
      this.failTurn(
        new Error('OpenCode produced no output for 45 minutes; the turn was abandoned'),
      );
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
    if (!this.sessionId || !this.baseUrl) {
      this.pendingAbort = true;
      return;
    }
    await this.sendInterrupt();
  }

  private async sendInterrupt(): Promise<void> {
    if (!this.sessionId || !this.baseUrl) return;
    await this.request(`/api/session/${this.sessionId}/interrupt`, { method: 'POST' }).catch(() => {});
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    this.streamAbort?.abort();
    this.streamAbort = null;
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    if (!child) return;
    await terminateChild(child);
  }
}

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  guidance: CHAT_GUIDANCE,
  createRunner: (context) => new OpenCodeRunner(context),
};
