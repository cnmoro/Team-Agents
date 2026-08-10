import { describe, expect, it } from 'vitest';
import { buildSandboxCodexConfig } from './codex.js';

describe('buildSandboxCodexConfig', () => {
  it('produces an empty config when nothing was seeded and no override is set', () => {
    expect(buildSandboxCodexConfig(null, '')).toBe('');
  });

  it('inherits the operator model choice from a seeded config.toml', () => {
    const seeded = 'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n';
    expect(buildSandboxCodexConfig(seeded, '')).toBe('model = "gpt-5.4"\n');
  });

  it('strips everything from the seeded config.toml except model — the operator\'s trusted-project paths and notice/TUI state do not leak into the sandbox', () => {
    // This is the shape a real operator's ~/.codex/config.toml can carry: a
    // trust table of every absolute project path they've ever opened Codex in
    // (potentially sensitive names/paths unrelated to the sandboxed repo),
    // plus host-machine-specific notice/TUI nudge state. Every sandbox for
    // every user of this app used to inherit this wholesale (unfiltered
    // `copyFile`, no processing step at all — worse than the equivalent
    // OpenCode bug, which at least ran a merge before this fix).
    const seeded = [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "medium"',
      'approvals_reviewer = "user"',
      '',
      '[projects."/home/operator/some-client-project"]',
      'trust_level = "trusted"',
      '',
      '[projects."/home/operator/another-project"]',
      'trust_level = "trusted"',
      '',
      '[tui.model_availability_nux]',
      '"gpt-5.5" = 4',
      '',
      '[notice]',
      'hide_rate_limit_model_nudge = true',
    ].join('\n');
    const result = buildSandboxCodexConfig(seeded, '');
    expect(result).toBe('model = "gpt-5.4"\n');
    expect(result).not.toContain('projects');
    expect(result).not.toContain('client-project');
    expect(result).not.toContain('tui');
    expect(result).not.toContain('notice');
  });

  it('an explicit CODEX_MODEL env override wins over the seeded model', () => {
    const seeded = 'model = "gpt-5.4"\n';
    expect(buildSandboxCodexConfig(seeded, 'gpt-5.9')).toBe('model = "gpt-5.9"\n');
  });

  it('an env override applies even with nothing seeded', () => {
    expect(buildSandboxCodexConfig(null, 'gpt-5.9')).toBe('model = "gpt-5.9"\n');
  });

  it('tolerates a seeded config.toml with no top-level model key', () => {
    const seeded = '[projects."/home/operator/x"]\ntrust_level = "trusted"\n';
    expect(buildSandboxCodexConfig(seeded, '')).toBe('');
  });
});
