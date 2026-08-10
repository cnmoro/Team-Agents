import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Bubblewrap process isolation.
 *
 * The goal is filesystem containment, not a security boundary against a
 * determined attacker: an agent gets a private, writable home and work tree, a
 * read-only view of the system, and nothing else from the host. Networking is
 * deliberately shared — every harness needs to reach its model provider and git
 * remotes — so this protects the host's files, not its network.
 */

/** Where the sandbox's private home and work tree appear from inside. */
export const SANDBOX_HOME = '/home/agent';
export const SANDBOX_WORK = '/work';

export interface BwrapMount {
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}

export interface BwrapOptions {
  /** Host directory exposed at {@link SANDBOX_HOME}. */
  homeDir: string;
  /** Host directory exposed at {@link SANDBOX_WORK}. */
  workDir: string;
  /** Extra host paths (harness install roots, ssh known_hosts, ...). */
  extraMounts?: BwrapMount[];
  /** Working directory inside the sandbox. */
  cwd?: string;
}

let cachedProbe: { available: boolean; version: string | null; reason: string | null } | null = null;

export function bwrapBinary(): string {
  return config.bwrapBin || 'bwrap';
}

/**
 * Verifies bubblewrap is usable by actually running a trivial sandbox. Merely
 * finding the binary is not enough: unprivileged user namespaces are disabled
 * on some kernels and the failure only appears at spawn time.
 */
export async function probeBubblewrap(force = false): Promise<{
  available: boolean;
  version: string | null;
  reason: string | null;
}> {
  if (cachedProbe && !force) return cachedProbe;

  if (!config.sandboxEnabled) {
    cachedProbe = { available: false, version: null, reason: 'Sandboxing disabled by configuration' };
    return cachedProbe;
  }

  try {
    const { stdout } = await execFileAsync(bwrapBinary(), ['--version'], { timeout: 5000 });
    const version = stdout.trim();
    await execFileAsync(
      bwrapBinary(),
      [...baseIsolationArgs(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '/bin/true'],
      { timeout: 10_000 },
    );
    cachedProbe = { available: true, version, reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cachedProbe = {
      available: false,
      version: null,
      reason: message.includes('ENOENT')
        ? 'bubblewrap (bwrap) is not installed'
        : `bubblewrap cannot create a sandbox: ${message.split('\n')[0]}`,
    };
  }
  return cachedProbe;
}

/**
 * Binds the real resolv.conf over the one inherited from /etc.
 *
 * On systemd-resolved and WSL2 alike, /etc/resolv.conf is a symlink to a file
 * outside /etc (/run/systemd/... or /mnt/wsl/...). Read-only binding /etc
 * therefore carries the dangling symlink into the sandbox and every hostname
 * lookup fails, which surfaces as "Could not resolve host" on the first git
 * clone. Mounting the symlink's target at its own path makes the inherited
 * symlink resolve again, which works on any layout without special-casing a
 * platform. (Binding over /etc/resolv.conf itself does not work: bubblewrap
 * follows the dangling symlink when creating the mountpoint and fails.)
 */
function dnsArgs(): string[] {
  try {
    const resolved = realpathSync('/etc/resolv.conf');
    if (resolved !== '/etc/resolv.conf') {
      return ['--ro-bind-try', resolved, resolved];
    }
  } catch {
    // No resolv.conf at all: leave the sandbox's view untouched.
  }
  return [];
}

/** The read-only system view every sandbox shares. */
function baseIsolationArgs(): string[] {
  return [
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    // Detaches the controlling terminal so a sandboxed process cannot inject
    // keystrokes into the server's tty via TIOCSTI.
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    // Merged-/usr systems expose these as symlinks; recreating them keeps
    // interpreter paths such as /lib64/ld-linux-x86-64.so.2 resolvable.
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    // /etc carries TLS roots, DNS config, and the passwd database.
    '--ro-bind', '/etc', '/etc',
    ...dnsArgs(),
  ];
}

/** Builds the full bwrap argv that wraps `command`. */
export function buildBwrapArgs(
  options: BwrapOptions,
  command: string,
  commandArgs: string[],
): string[] {
  const args = [
    ...baseIsolationArgs(),
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', options.homeDir, SANDBOX_HOME,
    '--bind', options.workDir, SANDBOX_WORK,
  ];

  for (const mount of options.extraMounts ?? []) {
    args.push(mount.readOnly ? '--ro-bind-try' : '--bind-try', mount.hostPath, mount.sandboxPath);
  }

  args.push('--chdir', options.cwd ?? SANDBOX_WORK, '--', command, ...commandArgs);
  return args;
}

/** Base environment for a sandboxed process. */
export function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: SANDBOX_HOME,
    USER: 'agent',
    LOGNAME: 'agent',
    SHELL: '/bin/bash',
    LANG: process.env.LANG ?? 'C.UTF-8',
    // Harnesses render ANSI art and progress bars when they detect a terminal;
    // a dumb terminal keeps the captured stream parseable.
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
    // Every sandboxed process gets a working `git`/`ssh` by default, not just
    // the initial provisioning clone: without this, an agent's own later
    // `git push`/`fetch` (run via its own Bash tool, a separate spawn from
    // provisionRepository's) falls back to plain `ssh`, which also parses the
    // *system* `/etc/ssh/ssh_config` — on modern Debian/Ubuntu that `Include`s
    // a root-owned file bubblewrap's unprivileged user namespace makes appear
    // owned by nobody, so ssh rejects it with "Bad owner or permissions"
    // before authentication even starts (see gitProvisioner.ts's
    // `sshConfigPath()` doc comment for the full mechanism). Pinning `-F` here
    // too closes that gap for every sandboxed command, not just provisioning.
    // `gitProvisioner.ts`'s `gitEnv()` still owns the askpass (passphrase)
    // variant, passed as `extra` below, which intentionally overrides this.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh -F ${SANDBOX_HOME}/.ssh/config -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
    ...extra,
  };
  for (const key of Object.keys(env)) if (!env[key]) delete env[key];
  return env;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
