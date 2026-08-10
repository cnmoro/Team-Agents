import { describe, expect, it } from 'vitest';
import { buildSandboxOpencodeConfig } from './opencode.js';

describe('buildSandboxOpencodeConfig', () => {
  it('starts from scratch when nothing was seeded', () => {
    const result = buildSandboxOpencodeConfig(null, '');
    expect(result).toEqual({
      $schema: 'https://opencode.ai/config.json',
      permission: expect.any(Object),
    });
  });

  it('inherits the operator model choice from a seeded config', () => {
    const seeded = JSON.stringify({ model: 'anthropic/claude-opus-4' });
    const result = buildSandboxOpencodeConfig(seeded, '');
    expect(result.model).toBe('anthropic/claude-opus-4');
  });

  it('strips everything from the seeded config except model — plugins and compaction settings do not leak into the sandbox', () => {
    // This is the exact shape a real operator's ~/.config/opencode/opencode.json
    // can carry: their own third-party plugins and compaction preference. Every
    // sandbox for every user of this app used to inherit these wholesale.
    const seeded = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      model: 'opencode/deepseek-v4-flash-free',
      plugin: ['@some-vendor/arbitrary-plugin@1.0.0'],
      compaction: { auto: false, prune: false },
      permission: 'allow',
    });
    const result = buildSandboxOpencodeConfig(seeded, '');
    expect(result.model).toBe('opencode/deepseek-v4-flash-free');
    expect(result.plugin).toBeUndefined();
    expect(result.compaction).toBeUndefined();
    // permission is always the sandbox's own locked-down policy, never the
    // operator's own (which here was the wide-open string 'allow').
    expect(result.permission).not.toBe('allow');
  });

  it('an explicit OPENCODE_MODEL env override wins over the seeded model', () => {
    const seeded = JSON.stringify({ model: 'opencode/deepseek-v4-flash-free' });
    const result = buildSandboxOpencodeConfig(seeded, 'anthropic/claude-opus-4');
    expect(result.model).toBe('anthropic/claude-opus-4');
  });

  it('tolerates unreadable/invalid seeded JSON instead of throwing', () => {
    const result = buildSandboxOpencodeConfig('{not valid json', '');
    expect(result.model).toBeUndefined();
    expect(result.$schema).toBe('https://opencode.ai/config.json');
  });
});
