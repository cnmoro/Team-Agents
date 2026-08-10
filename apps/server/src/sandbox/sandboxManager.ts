import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessId } from '@teamagents/shared';
import { config, paths } from '../config.js';
import { authSeedsFor, harnessMounts, type HarnessInstall } from '../agents/harnessRegistry.js';
import {
  SANDBOX_HOME,
  SANDBOX_WORK,
  buildBwrapArgs,
  pathExists,
  probeBubblewrap,
  sandboxEnv,
  bwrapBinary,
  type BwrapMount,
} from './bubblewrap.js';

/**
 * Persistent per-session sandboxes.
 *
 * A sandbox outlives the process that created it: the directory survives turn
 * completion, server restarts, and reboots, so a follow-up prompt reuses the
 * same clones, the same harness session state, and the same build artifacts. It
 * is removed only when the user explicitly closes the session.
 */

export interface Sandbox {
  agentSessionId: string;
  /** Host directory containing `home/` and `work/`. */
  root: string;
  homeDir: string;
  workDir: string;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  /** Path *inside* the sandbox. Defaults to {@link SANDBOX_WORK}. */
  cwd?: string;
  env?: Record<string, string>;
  extraMounts?: BwrapMount[];
}

export function sandboxRoot(agentSessionId: string): string {
  return path.join(paths.sandboxes, agentSessionId);
}

/**
 * Package and tool caches shared by every sandbox of a given harness.
 *
 * Sandboxes are permanent, so anything downloaded inside one is kept forever.
 * Left alone, each OpenCode session pulled roughly a gigabyte of npm, bun, and
 * model-catalog caches into its own private home — the same gigabyte, once per
 * session. Mounting one cache per harness turns that into a single copy and
 * makes second and later sessions start far faster.
 *
 * The trade-off is deliberate: agents of the same harness share a writable
 * cache, so they are not isolated from each other's downloads. They already run
 * as the same user on the same host with the same credentials, so this adds no
 * meaningful exposure. Set `SHARE_AGENT_CACHES=false` to opt out and pay the
 * disk cost instead.
 */
export function sharedCachePaths(harness: HarnessId): { xdgCache: string; npm: string } {
  const root = path.join(config.dataDir, 'cache', harness);
  return { xdgCache: path.join(root, 'xdg'), npm: path.join(root, 'npm') };
}

export function describeSandbox(agentSessionId: string): Sandbox {
  const root = sandboxRoot(agentSessionId);
  return {
    agentSessionId,
    root,
    homeDir: path.join(root, 'home'),
    workDir: path.join(root, 'work'),
  };
}

/**
 * Creates the sandbox directory tree if absent and seeds it with the harness's
 * credentials and a git configuration. Safe to call repeatedly: an existing
 * sandbox is left untouched apart from refreshing credentials, which keeps a
 * long-lived session working after the operator re-authenticates on the host.
 */
export async function ensureSandbox(
  agentSessionId: string,
  harness: HarnessId,
): Promise<Sandbox> {
  const sandbox = describeSandbox(agentSessionId);
  await mkdir(sandbox.homeDir, { recursive: true });
  await mkdir(sandbox.workDir, { recursive: true });
  await mkdir(path.join(sandbox.homeDir, '.ssh'), { recursive: true, mode: 0o700 });

  if (config.shareAgentCaches) {
    const caches = sharedCachePaths(harness);
    await mkdir(caches.xdgCache, { recursive: true });
    await mkdir(caches.npm, { recursive: true });
  }

  await seedCredentials(sandbox, harness);
  await seedGitConfig(sandbox);
  return sandbox;
}

async function seedCredentials(sandbox: Sandbox, harness: HarnessId): Promise<void> {
  for (const seed of authSeedsFor(harness)) {
    if (!(await pathExists(seed.hostPath))) continue;
    // Anything under `.cache/` must land in the shared cache directory, since
    // that path is bind-mounted over the sandbox's own home at spawn time and
    // a copy written here would be invisible inside the sandbox.
    const isCache = seed.sandboxRelative.startsWith('.cache/');
    const destination =
      config.shareAgentCaches && isCache
        ? path.join(sharedCachePaths(harness).xdgCache, seed.sandboxRelative.slice('.cache/'.length))
        : path.join(sandbox.homeDir, seed.sandboxRelative);

    await mkdir(path.dirname(destination), { recursive: true });
    // Credentials are refreshed every time so a re-login on the host reaches
    // long-lived sessions; caches are seeded once and then left to the harness.
    if (isCache && (await pathExists(destination))) continue;
    await copyFile(seed.hostPath, destination).catch(() => {
      // A credential that cannot be copied is not fatal: the harness may still
      // authenticate from an environment variable.
    });
  }

  if (harness === 'claude-code') {
    // Without this marker the CLI tries to run its first-run onboarding, which
    // never completes on a non-interactive stream.
    const marker = path.join(sandbox.homeDir, '.claude.json');
    if (!(await pathExists(marker))) {
      await writeFile(
        marker,
        JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }, null, 2),
      );
    }
  }
}

async function seedGitConfig(sandbox: Sandbox): Promise<void> {
  const gitconfig = path.join(sandbox.homeDir, '.gitconfig');
  if (await pathExists(gitconfig)) return;
  await writeFile(
    gitconfig,
    [
      '[user]',
      '\tname = TeamAgents Agent',
      '\temail = agent@teamagents.local',
      '[init]',
      '\tdefaultBranch = main',
      '[safe]',
      '\tdirectory = *',
      '[advice]',
      '\tdetachedHead = false',
      '',
    ].join('\n'),
  );
}

/**
 * Removes a sandbox and everything in it. Irreversible.
 *
 * A session can be closed while it is still provisioning — the background
 * clone/setup work spawned by `startAgent` may still be writing files under
 * `sandbox.root` at the exact moment this walks the tree to delete it. That
 * TOCTOU race throws `ENOTEMPTY` on the final `rmdir` even with `force`,
 * which isn't a real failure — it just means a concurrent writer lost the
 * race. `maxRetries`/`retryDelay` make `rm` retry on exactly that class of
 * transient error instead of surfacing a 500 to whoever clicked "Close &
 * erase" a beat too early.
 */
export async function destroySandbox(agentSessionId: string): Promise<void> {
  const sandbox = describeSandbox(agentSessionId);
  await rm(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function sandboxExists(agentSessionId: string): Promise<boolean> {
  return pathExists(describeSandbox(agentSessionId).root);
}

/**
 * Launches a process inside the sandbox.
 *
 * When bubblewrap is unavailable and sandboxing has been explicitly disabled,
 * the command runs directly with the sandbox directories as its home and
 * working tree. That fallback is opt-in precisely because it removes the
 * containment this module exists to provide.
 */
export async function spawnInSandbox(
  sandbox: Sandbox,
  install: HarnessInstall,
  options: SpawnOptions,
): Promise<ChildProcessWithoutNullStreams> {
  const probe = await probeBubblewrap();
  // If any bound SSH credential needed a passphrase, `installCredential()`
  // (gitProvisioner.ts) left an askpass helper script behind for the life of
  // the sandbox. sandboxEnv()'s default GIT_SSH_COMMAND uses BatchMode=yes,
  // which would silently defeat that helper for every command *after* the
  // initial clone (BatchMode disables all interactive-style prompts,
  // including the SSH_ASKPASS handshake) — so a passphrase-protected key's
  // clone would succeed but the agent's own later `git push`/`fetch` would
  // fail with "Permission denied (publickey)" again. Detect the helper and
  // switch every command in this sandbox to the askpass-compatible variant,
  // the same one gitEnv(true) uses for provisioning.
  const askpassPath = path.join(sandbox.homeDir, '.ssh', 'askpass');
  const askpassEnv: Record<string, string> = existsSync(askpassPath)
    ? {
        SSH_ASKPASS: `${SANDBOX_HOME}/.ssh/askpass`,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: ':0',
        GIT_SSH_COMMAND: `ssh -F ${SANDBOX_HOME}/.ssh/config -o StrictHostKeyChecking=accept-new`,
      }
    : {};
  const env = sandboxEnv({ ...askpassEnv, ...options.env });

  if (!probe.available) {
    if (config.sandboxEnabled) {
      throw new Error(
        `Cannot start agent: ${probe.reason ?? 'bubblewrap is unavailable'}. ` +
          'Install bubblewrap, or set SANDBOX_ENABLED=false to run agents unsandboxed.',
      );
    }
    // Unsandboxed fallback: translate sandbox-internal paths back to the host.
    const hostCwd = toHostPath(sandbox, options.cwd ?? SANDBOX_WORK);
    return spawn(options.command, options.args, {
      cwd: hostCwd,
      env: { ...env, HOME: sandbox.homeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  }

  const caches = sharedCachePaths(install.id);
  const mounts = [
    ...harnessMounts(install),
    ...(config.shareAgentCaches
      ? [
          { hostPath: caches.xdgCache, sandboxPath: `${SANDBOX_HOME}/.cache`, readOnly: false },
          { hostPath: caches.npm, sandboxPath: `${SANDBOX_HOME}/.npm`, readOnly: false },
        ]
      : []),
    ...(options.extraMounts ?? []),
  ];
  const args = buildBwrapArgs(
    {
      homeDir: sandbox.homeDir,
      workDir: sandbox.workDir,
      extraMounts: mounts,
      cwd: options.cwd ?? SANDBOX_WORK,
    },
    options.command,
    options.args,
  );

  return spawn(bwrapBinary(), args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

/** Runs a command to completion inside the sandbox and collects its output. */
export async function runInSandbox(
  sandbox: Sandbox,
  install: HarnessInstall,
  options: SpawnOptions & { timeoutMs?: number; input?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = await spawnInSandbox(sandbox, install, options);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  if (options.input !== undefined) {
    child.stdin.write(options.input);
    child.stdin.end();
  }

  return new Promise((resolve, reject) => {
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${options.command}`));
        }, options.timeoutMs)
      : null;

    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Maps a path inside the sandbox back to its location on the host. */
export function toHostPath(sandbox: Sandbox, sandboxPath: string): string {
  if (sandboxPath === SANDBOX_WORK || sandboxPath.startsWith(`${SANDBOX_WORK}/`)) {
    return path.join(sandbox.workDir, sandboxPath.slice(SANDBOX_WORK.length));
  }
  if (sandboxPath === SANDBOX_HOME || sandboxPath.startsWith(`${SANDBOX_HOME}/`)) {
    return path.join(sandbox.homeDir, sandboxPath.slice(SANDBOX_HOME.length));
  }
  return sandboxPath;
}

export { SANDBOX_HOME, SANDBOX_WORK };
