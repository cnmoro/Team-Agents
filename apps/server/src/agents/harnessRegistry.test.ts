import { describe, expect, it } from 'vitest';
import { authSeedsFor } from './harnessRegistry.js';

describe('authSeedsFor("claude-code")', () => {
  // Regression guard for the bug class found and fixed for OpenCode (18th QA
  // pass) and Codex (19th QA pass): both used to copy the operator's entire
  // host config file (opencode.json / config.toml) unfiltered into every
  // sandbox, leaking things like hooks, MCP server config, plugin lists, and
  // (for OpenCode) a setting that silently disabled auto-compaction. Claude
  // Code was audited for the same pattern in the 20th pass and found clean —
  // this test pins that down so a future change can't reintroduce it.
  it('only seeds the OAuth credentials file, never settings.json/CLAUDE.md/hooks/MCP config', () => {
    const seeds = authSeedsFor('claude-code');
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.sandboxRelative).toBe('.claude/.credentials.json');
    // Nothing that could carry hooks, MCP servers, or other host-machine
    // settings should ever be seeded for this harness.
    for (const seed of seeds) {
      expect(seed.sandboxRelative).not.toMatch(/settings\.json$/);
      expect(seed.sandboxRelative).not.toMatch(/CLAUDE\.md$/i);
      expect(seed.hostPath).not.toMatch(/settings\.json$/);
    }
  });
});
