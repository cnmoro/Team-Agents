import { describe, expect, it } from 'vitest';
import { detectProtocol, gitEnv, redactSecrets, repoDirName } from './gitProvisioner.js';

describe('detectProtocol', () => {
  it('recognizes HTTPS remotes', () => {
    expect(detectProtocol('https://github.com/org/repo.git')).toBe('https');
    expect(detectProtocol('http://internal.git/repo.git')).toBe('https');
  });

  it('recognizes SSH remotes in both syntaxes', () => {
    expect(detectProtocol('git@github.com:org/repo.git')).toBe('ssh');
    expect(detectProtocol('ssh://git@gitlab.internal:2222/org/repo.git')).toBe('ssh');
    expect(detectProtocol('deploy-user@host.example:path/repo.git')).toBe('ssh');
  });

  it('ignores surrounding whitespace', () => {
    expect(detectProtocol('  git@github.com:org/repo.git  ')).toBe('ssh');
  });
});

describe('repoDirName', () => {
  it('keeps safe names unchanged', () => {
    expect(repoDirName('my-service')).toBe('my-service');
    expect(repoDirName('api.v2_final')).toBe('api.v2_final');
  });

  it('neutralizes path traversal and separators', () => {
    // The result becomes a directory name inside the sandbox, so it must never
    // be able to escape /work.
    expect(repoDirName('../../etc/passwd')).not.toContain('/');
    expect(repoDirName('../../etc/passwd')).not.toContain('..\\');
    expect(repoDirName('a/b')).toBe('a-b');
    expect(repoDirName('a b')).toBe('a-b');
  });

  it('never returns an empty name', () => {
    expect(repoDirName('///')).toBeTruthy();
    expect(repoDirName('')).toBe('repo');
  });

  it('bounds the length', () => {
    expect(repoDirName('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe('redactSecrets', () => {
  it('removes credentials embedded in a remote URL', () => {
    const message = "fatal: could not read from 'https://user:ghp_secret@github.com/org/repo.git'";
    const redacted = redactSecrets(message);
    expect(redacted).not.toContain('ghp_secret');
    expect(redacted).toContain('***:***@github.com');
  });

  it('removes a private key block', () => {
    const message = [
      'error loading key',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAA',
      '-----END OPENSSH PRIVATE KEY-----',
      'permission denied',
    ].join('\n');
    const redacted = redactSecrets(message);
    expect(redacted).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(redacted).toContain('[redacted private key]');
    expect(redacted).toContain('permission denied');
  });

  it('leaves harmless output alone', () => {
    expect(redactSecrets('Cloning into /work/repo...')).toBe('Cloning into /work/repo...');
  });

  it('caps the length so a huge error cannot flood the chat', () => {
    expect(redactSecrets('x'.repeat(50_000)).length).toBeLessThanOrEqual(8000);
  });
});

describe('gitEnv', () => {
  it('disables interactive prompts', () => {
    // A prompt inside a sandbox has nobody to answer it and would hang the run.
    expect(gitEnv(false).GIT_TERMINAL_PROMPT).toBe('0');
    expect(gitEnv(false).GIT_SSH_COMMAND).toContain('BatchMode=yes');
  });

  it('wires an askpass helper when the key has a passphrase', () => {
    const env = gitEnv(true);
    expect(env.SSH_ASKPASS).toContain('.ssh/askpass');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    // BatchMode would defeat the askpass helper, so it must not be set here.
    expect(env.GIT_SSH_COMMAND).not.toContain('BatchMode');
  });
});
