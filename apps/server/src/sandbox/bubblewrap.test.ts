import { describe, expect, it } from 'vitest';
import { sandboxEnv } from './bubblewrap.js';

describe('sandboxEnv', () => {
  it('pins GIT_SSH_COMMAND to the sandbox-local ssh config by default', () => {
    // Regression guard: this is the environment every sandboxed process gets,
    // including the harness's own long-running process (Claude Code / Codex /
    // OpenCode). Without this default, only the initial provisioning clone/
    // fetch (gitProvisioner.ts's own `gitEnv()`) got the `-F` pin — an agent's
    // *own* later `git push`/`fetch`, run via its own Bash tool as a separate
    // spawn, fell back to plain `ssh`, which also parses the host's system
    // `/etc/ssh/ssh_config`. On modern Debian/Ubuntu that `Include`s a
    // root-owned file that bubblewrap's implicit unprivileged user namespace
    // makes appear owned by the nobody overflow uid from inside the sandbox,
    // so ssh's strict permission check rejects it with "Bad owner or
    // permissions" before authentication even starts. Verified for real: a
    // live agent session's first plain `git push` failed with exactly that
    // error; only after manually pinning `GIT_SSH_COMMAND` itself (as this fix
    // now does by default) did the push reach the remote.
    const env = sandboxEnv();
    expect(env.GIT_SSH_COMMAND).toContain('-F /home/agent/.ssh/config');
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('lets a caller override GIT_SSH_COMMAND (the askpass/passphrase branch)', () => {
    const env = sandboxEnv({ GIT_SSH_COMMAND: 'ssh -F /home/agent/.ssh/config' });
    expect(env.GIT_SSH_COMMAND).not.toContain('BatchMode');
  });

  it('keeps the existing base environment', () => {
    const env = sandboxEnv();
    expect(env.HOME).toBe('/home/agent');
    expect(env.USER).toBe('agent');
    expect(env.TERM).toBe('dumb');
  });
});
