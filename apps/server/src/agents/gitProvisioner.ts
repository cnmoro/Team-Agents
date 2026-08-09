import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessInstall } from './harnessRegistry.js';
import { CredentialModel } from '../models/credential.js';
import type { RepositoryDoc } from '../models/repository.js';
import { decryptJson } from '../services/secretBox.js';
import { SANDBOX_HOME, SANDBOX_WORK } from '../sandbox/bubblewrap.js';
import { pathExists } from '../sandbox/bubblewrap.js';
import { runInSandbox, type Sandbox } from '../sandbox/sandboxManager.js';

/**
 * Materializes git credentials inside a sandbox and clones repositories.
 *
 * Credentials are written into the sandbox rather than injected per-command
 * because the agent runs its own git operations — fetch, commit, push — long
 * after cloning, and those must work without the server in the loop. The
 * material therefore lives in the session's private directory (0600, inside a
 * directory only the server user can read) for the lifetime of the sandbox and
 * is destroyed with it.
 */

export interface HttpsSecret {
  token: string;
}
export interface SshSecret {
  privateKey: string;
  passphrase?: string;
}

/** Classifies a remote URL so the right credential mechanism is used. */
export function detectProtocol(url: string): 'https' | 'ssh' {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return 'https';
  if (/^ssh:\/\//i.test(trimmed)) return 'ssh';
  // scp-like syntax: git@github.com:owner/repo.git
  if (/^[^/]+@[^/:]+:/.test(trimmed)) return 'ssh';
  if (/^(file|git):\/\//i.test(trimmed)) return 'https';
  return 'https';
}

/** Extracts the host used to scope an SSH config entry. */
function sshHostOf(url: string): string | null {
  const scpLike = /^[^@]+@([^:]+):/.exec(url.trim());
  if (scpLike) return scpLike[1]!;
  const uri = /^ssh:\/\/(?:[^@]+@)?([^/:]+)/i.exec(url.trim());
  if (uri) return uri[1]!;
  return null;
}

/** Derives a safe directory name for a repository inside `/work`. */
export function repoDirName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'repo';
}

interface ResolvedCredential {
  type: 'https_token' | 'ssh_key';
  username: string | null;
  https?: HttpsSecret;
  ssh?: SshSecret;
}

async function loadCredential(credentialId: string): Promise<ResolvedCredential | null> {
  const doc = await CredentialModel.findById(credentialId);
  if (!doc) return null;
  if (doc.type === 'https_token') {
    return {
      type: 'https_token',
      username: doc.username ?? 'git',
      https: decryptJson<HttpsSecret>(doc.secret),
    };
  }
  return {
    type: 'ssh_key',
    username: doc.username ?? null,
    ssh: decryptJson<SshSecret>(doc.secret),
  };
}

/**
 * Installs a credential into the sandbox so every later git invocation — ours
 * or the agent's — authenticates without prompting.
 */
async function installCredential(
  sandbox: Sandbox,
  repository: RepositoryDoc,
  credential: ResolvedCredential,
): Promise<{ needsAskpass: boolean }> {
  if (credential.type === 'https_token' && credential.https) {
    // git's `store` helper reads plain `https://user:pass@host` lines.
    const url = new URL(repository.url);
    const entry = `${url.protocol}//${encodeURIComponent(credential.username ?? 'git')}:${encodeURIComponent(
      credential.https.token,
    )}@${url.host}\n`;
    const credentialsFile = path.join(sandbox.homeDir, '.git-credentials');
    const existing = (await readFile(credentialsFile, 'utf8').catch(() => '')) as string;
    if (!existing.includes(entry.trim())) await appendFile(credentialsFile, entry);
    await chmod(credentialsFile, 0o600);

    const gitconfig = path.join(sandbox.homeDir, '.gitconfig');
    const config = (await readFile(gitconfig, 'utf8').catch(() => '')) as string;
    if (!config.includes('helper = store')) {
      await appendFile(gitconfig, '\n[credential]\n\thelper = store\n');
    }
    return { needsAskpass: false };
  }

  if (credential.type === 'ssh_key' && credential.ssh) {
    const sshDir = path.join(sandbox.homeDir, '.ssh');
    await mkdir(sshDir, { recursive: true, mode: 0o700 });

    const keyName = `id_${repoDirName(repository.name)}`;
    const keyPath = path.join(sshDir, keyName);
    const key = credential.ssh.privateKey.endsWith('\n')
      ? credential.ssh.privateKey
      : `${credential.ssh.privateKey}\n`;
    await writeFile(keyPath, key, { mode: 0o600 });
    await chmod(keyPath, 0o600);

    const host = sshHostOf(repository.url);
    if (host) {
      const configPath = path.join(sshDir, 'config');
      const existing = (await readFile(configPath, 'utf8').catch(() => '')) as string;
      const marker = `# teamagents:${repository.name}`;
      if (!existing.includes(marker)) {
        await appendFile(
          configPath,
          [
            '',
            marker,
            `Host ${host}`,
            `  IdentityFile ${SANDBOX_HOME}/.ssh/${keyName}`,
            '  IdentitiesOnly yes',
            // First contact with a remote must not block on a host-key prompt.
            '  StrictHostKeyChecking accept-new',
            `  UserKnownHostsFile ${SANDBOX_HOME}/.ssh/known_hosts`,
            '',
          ].join('\n'),
        );
        await chmod(configPath, 0o600);
      }
    }

    if (credential.ssh.passphrase) {
      // ssh reads the passphrase from this helper instead of the terminal.
      const askpass = path.join(sshDir, 'askpass');
      await writeFile(
        askpass,
        `#!/bin/sh\ncat <<'TEAMAGENTS_EOF'\n${credential.ssh.passphrase}\nTEAMAGENTS_EOF\n`,
        { mode: 0o700 },
      );
      await chmod(askpass, 0o700);
      return { needsAskpass: true };
    }
  }

  return { needsAskpass: false };
}

/**
 * The sandbox-local ssh config every git invocation is pinned to via `-F`.
 *
 * Without `-F`, ssh also parses the *system* `/etc/ssh/ssh_config`, which on
 * modern Debian/Ubuntu (and therefore most container/host images) contains
 * `Include /etc/ssh/ssh_config.d/*.conf`. Bubblewrap's unprivileged sandbox
 * runs in an implicit user namespace that only maps the invoking uid — every
 * other uid, including root, has no mapping and appears as the nobody
 * overflow uid (65534) when `stat`'d from inside the sandbox. ssh's own
 * strict permission check on *included* config files rejects a file that
 * looks owned by neither root nor the invoking user, so a real, root-owned,
 * 0644 system file (e.g. `20-systemd-ssh-proxy.conf`) fails with "Bad owner
 * or permissions" purely because of how it appears through the sandbox's uid
 * mapping — before ssh ever attempts authentication. Pinning `-F` to a file
 * inside the sandbox's own (agent-owned) home directory skips the system
 * config entirely, sidestepping the false "bad owner" rejection.
 */
export function sshConfigPath(): string {
  return `${SANDBOX_HOME}/.ssh/config`;
}

/**
 * Ensures the sandbox has a `~/.ssh/config` file `-F` can point at. ssh
 * refuses to start if `-F` names a file that does not exist, so every git
 * invocation needs one present even when no SSH credential is bound (e.g. an
 * anonymous `ssh://` or `git@host:` remote).
 */
export async function ensureSshConfigFile(sandbox: Sandbox): Promise<void> {
  const sshDir = path.join(sandbox.homeDir, '.ssh');
  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(sshDir, 'config');
  if (!(await pathExists(configPath))) {
    await writeFile(configPath, '', { mode: 0o600 });
  }
}

/** Environment additions that make non-interactive git work in the sandbox. */
export function gitEnv(needsAskpass: boolean): Record<string, string> {
  const env: Record<string, string> = {
    // Never fall back to an interactive prompt: it would hang the agent.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh -F ${sshConfigPath()} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
  };
  if (needsAskpass) {
    env.SSH_ASKPASS = `${SANDBOX_HOME}/.ssh/askpass`;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env.DISPLAY = ':0';
    delete env.GIT_SSH_COMMAND;
    env.GIT_SSH_COMMAND = `ssh -F ${sshConfigPath()} -o StrictHostKeyChecking=accept-new`;
  }
  return env;
}

export interface CloneResult {
  repositoryId: string;
  name: string;
  url: string;
  sandboxPath: string;
  cloned: boolean;
  cloneError: string | null;
  /** True when the working copy already existed and was only refreshed. */
  reused: boolean;
}

/**
 * Clones a repository into the sandbox, or refreshes it if already present.
 * Reuse is the normal case for a persistent sandbox: the second prompt against
 * a session should not pay for a full clone.
 */
export async function provisionRepository(
  sandbox: Sandbox,
  install: HarnessInstall,
  repository: RepositoryDoc,
  log?: (message: string) => void,
): Promise<CloneResult> {
  const dirName = repoDirName(repository.name);
  const sandboxPath = `${SANDBOX_WORK}/${dirName}`;
  const hostPath = path.join(sandbox.workDir, dirName);

  const base: CloneResult = {
    repositoryId: String(repository._id),
    name: repository.name,
    url: repository.url,
    sandboxPath,
    cloned: false,
    cloneError: null,
    reused: false,
  };

  // Always present so `-F` in gitEnv() has a real file to point at, even for
  // an SSH remote with no bound credential.
  await ensureSshConfigFile(sandbox);

  let needsAskpass = false;
  if (repository.credentialId) {
    const credential = await loadCredential(String(repository.credentialId));
    if (!credential) {
      return { ...base, cloneError: 'The bound credential no longer exists' };
    }
    ({ needsAskpass } = await installCredential(sandbox, repository, credential));
  }

  const env = gitEnv(needsAskpass);

  if (await pathExists(path.join(hostPath, '.git'))) {
    log?.(`Reusing existing clone of ${repository.name}`);
    const fetch = await runInSandbox(sandbox, install, {
      command: 'git',
      args: ['-C', sandboxPath, 'fetch', '--all', '--prune'],
      env,
      timeoutMs: 180_000,
    }).catch((error: Error) => ({ code: -1, stdout: '', stderr: error.message }));
    if (fetch.code !== 0) {
      log?.(`Fetch failed for ${repository.name}: ${fetch.stderr.trim().split('\n').pop() ?? ''}`);
    }
    return { ...base, cloned: true, reused: true };
  }

  log?.(`Cloning ${repository.name} from ${repository.url}`);
  const args = ['clone', repository.url, sandboxPath];
  if (repository.defaultBranch) args.splice(1, 0, '--branch', repository.defaultBranch);

  const result = await runInSandbox(sandbox, install, {
    command: 'git',
    args,
    env,
    timeoutMs: 600_000,
  }).catch((error: Error) => ({ code: -1, stdout: '', stderr: error.message }));

  if (result.code !== 0) {
    return { ...base, cloneError: redactSecrets(result.stderr.trim()) || 'git clone failed' };
  }
  return { ...base, cloned: true };
}

/**
 * Strips anything that looks like an embedded credential from git output before
 * it reaches the chat, since git echoes remote URLs in its error messages.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/gi, '$1***:***@')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
    .slice(0, 8000);
}
