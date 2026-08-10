import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSandbox, destroySandbox, sandboxExists } from './sandboxManager.js';

describe('destroySandbox', () => {
  // Regression guard, 22nd QA pass: closing an agent session while it is
  // still provisioning races destroySandbox's recursive `rm` against a
  // concurrent writer still creating files under the same tree. On Linux
  // that TOCTOU window throws ENOTEMPTY on the final rmdir even with
  // `force: true`, which used to bubble out of DELETE /api/agents/:id as a
  // bare 500 — confirmed live via the real UI/API in the 22nd pass, closing
  // a session immediately after starting it. Reproduced here deterministically
  // by writing new files into the tree in a loop while destroySandbox runs
  // concurrently, which reliably hits the same race without needing a real
  // harness or bubblewrap.
  it('survives files being written concurrently by another process, instead of throwing ENOTEMPTY', async () => {
    const agentSessionId = `test-race-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sandbox = describeSandbox(agentSessionId);
    await mkdir(sandbox.workDir, { recursive: true });

    let writing = true;
    let writeCount = 0;
    const writer = (async () => {
      while (writing) {
        const dir = path.join(sandbox.workDir, `churn-${writeCount % 5}`);
        await mkdir(dir, { recursive: true }).catch(() => {});
        await writeFile(path.join(dir, `file-${writeCount}.txt`), 'x').catch(() => {});
        writeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    // Give the writer a head start so destroySandbox's walk overlaps with it,
    // the same way it overlaps with a still-running provisioning task in
    // production.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(destroySandbox(agentSessionId)).resolves.toBeUndefined();

    writing = false;
    await writer;

    // destroySandbox must win the race eventually: nothing should be left
    // behind once the concurrent writer has stopped and a final cleanup runs.
    await destroySandbox(agentSessionId);
    expect(await sandboxExists(agentSessionId)).toBe(false);
  });
});
