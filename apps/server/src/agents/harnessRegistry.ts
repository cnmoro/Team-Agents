import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HARNESSES, HARNESS_LABELS, type HarnessAvailability, type HarnessId } from '@teamagents/shared';
import { config } from '../config.js';
import { pathExists, type BwrapMount } from '../sandbox/bubblewrap.js';

const execFileAsync = promisify(execFile);

/**
 * Where each harness CLI lives on the host, what it needs mounted into a
 * sandbox to run, and which credential files to seed so an agent inherits the
 * operator's existing login instead of demanding an API key.
 */

export interface HarnessInstall {
  id: HarnessId;
  /** Fully resolved path to the executable (symlinks followed). */
  binPath: string;
  /**
   * Host directory that must be visible inside the sandbox for the binary to
   * run — its package root, not just the file, because CLIs load sibling
   * assets and vendored native modules.
   */
  installRoot: string;
  version: string | null;
}

/**
 * Credential files copied into a fresh sandbox home.
 *
 * They are *copied*, not bind-mounted: harnesses refresh OAuth tokens in place,
 * and a read-only mount would break that while a writable mount would let an
 * agent corrupt the operator's real login. Each sandbox therefore gets its own
 * copy that it may freely rewrite.
 */
interface AuthSeed {
  /** Path on the host, relative to the operator's home directory. */
  hostRelative: string;
  /** Destination, relative to the sandbox home. */
  sandboxRelative: string;
}

const AUTH_SEEDS: Record<HarnessId, AuthSeed[]> = {
  // Credentials only, deliberately. Copying the operator's settings.json would
  // drag their hooks, MCP servers, and CLAUDE.md into every agent run.
  'claude-code': [
    { hostRelative: '.claude/.credentials.json', sandboxRelative: '.claude/.credentials.json' },
  ],
  codex: [
    { hostRelative: '.codex/auth.json', sandboxRelative: '.codex/auth.json' },
    { hostRelative: '.codex/config.toml', sandboxRelative: '.codex/config.toml' },
  ],
  opencode: [
    { hostRelative: '.local/share/opencode/auth.json', sandboxRelative: '.local/share/opencode/auth.json' },
    // Selects the active provider account. Without it OpenCode falls back to a
    // built-in default model that the operator may have no access to, which
    // surfaces as an opaque upstream 503 on the first prompt.
    { hostRelative: '.local/share/opencode/account.json', sandboxRelative: '.local/share/opencode/account.json' },
    { hostRelative: '.config/opencode/opencode.json', sandboxRelative: '.config/opencode/opencode.json' },
    // The models.dev catalog. Seeding it avoids a slow download that races
    // session creation and can leave model resolution with a partial catalog.
    { hostRelative: '.cache/opencode/models.json', sandboxRelative: '.cache/opencode/models.json' },
  ],
};

const VERSION_ARGS: Record<HarnessId, string[]> = {
  'claude-code': ['--version'],
  codex: ['--version'],
  opencode: ['--version'],
};

const DEFAULT_COMMAND: Record<HarnessId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/** Extra host locations to search when a harness is not on PATH. */
function candidatePaths(id: HarnessId): string[] {
  const home = os.homedir();
  const byId: Record<HarnessId, string[]> = {
    'claude-code': [path.join(home, '.local/bin/claude')],
    codex: [path.join(home, '.npm/bin/codex'), path.join(home, '.local/bin/codex')],
    opencode: [path.join(home, '.opencode/bin/opencode'), path.join(home, '.local/bin/opencode')],
  };
  return byId[id];
}

async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [command], { timeout: 4000 });
    const found = stdout.trim().split('\n')[0];
    return found || null;
  } catch {
    return null;
  }
}

/**
 * Picks the directory to mount for a binary: the package root when the
 * executable sits in a `bin/` or `versions/` directory, otherwise its own
 * directory. Covers all three harnesses, which ship as a native binary under a
 * versioned directory, a Node script inside a package, and a native binary in
 * a `bin/` directory respectively.
 */
function deriveInstallRoot(binPath: string): string {
  const dir = path.dirname(binPath);
  const base = path.basename(dir);
  if (base === 'bin' || base === 'versions' || base === 'libexec') return path.dirname(dir);
  return dir;
}

async function detectVersion(binPath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, { timeout: 15_000 });
    const text = `${stdout}${stderr}`.trim().split('\n')[0] ?? '';
    return text.trim() || null;
  } catch {
    return null;
  }
}

const installCache = new Map<HarnessId, HarnessInstall | null>();

export async function resolveHarness(
  id: HarnessId,
  force = false,
): Promise<HarnessInstall | null> {
  if (!force && installCache.has(id)) return installCache.get(id) ?? null;

  const configured = config.harnessBins[id];
  const candidates = [
    ...(configured ? [configured] : []),
    ...(await which(DEFAULT_COMMAND[id]).then((p) => (p ? [p] : []))),
    ...candidatePaths(id),
  ];

  let install: HarnessInstall | null = null;
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    const resolved = await realpath(candidate).catch(() => candidate);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) continue;
    install = {
      id,
      binPath: resolved,
      installRoot: deriveInstallRoot(resolved),
      version: await detectVersion(resolved, VERSION_ARGS[id]),
    };
    break;
  }

  installCache.set(id, install);
  return install;
}

export async function listHarnessAvailability(force = false): Promise<HarnessAvailability[]> {
  return Promise.all(
    HARNESSES.map(async (id) => {
      const install = await resolveHarness(id, force);
      return {
        id,
        label: HARNESS_LABELS[id],
        available: Boolean(install),
        version: install?.version ?? null,
        reason: install ? null : `${HARNESS_LABELS[id]} CLI was not found on this host`,
      };
    }),
  );
}

/** Read-only mounts a sandbox needs in order to execute this harness. */
export function harnessMounts(install: HarnessInstall): BwrapMount[] {
  const mounts: BwrapMount[] = [
    { hostPath: install.installRoot, sandboxPath: install.installRoot, readOnly: true },
  ];
  // Node-based CLIs resolve their interpreter through PATH, which already points
  // at /usr/bin; nothing further is required for those.
  return mounts;
}

export function authSeedsFor(id: HarnessId): Array<{ hostPath: string; sandboxRelative: string }> {
  // Configurable so a container can mount the operator's real logins read-only
  // rather than baking them into an image or demanding an API key.
  const home = config.harnessCredentialsDir || os.homedir();
  return AUTH_SEEDS[id].map((seed) => ({
    hostPath: path.join(home, seed.hostRelative),
    sandboxRelative: seed.sandboxRelative,
  }));
}

/** Provider API keys forwarded into the sandbox, when configured. */
export function providerEnvFor(id: HarnessId): Record<string, string> {
  const env: Record<string, string> = {};
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY } = config.providerEnv;
  if (id === 'claude-code' && ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
  if (id === 'codex' && OPENAI_API_KEY) env.OPENAI_API_KEY = OPENAI_API_KEY;
  if (id === 'opencode') {
    if (ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
    if (OPENAI_API_KEY) env.OPENAI_API_KEY = OPENAI_API_KEY;
  }
  return env;
}
