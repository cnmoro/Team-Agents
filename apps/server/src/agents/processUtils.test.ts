import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { terminateChild } from './processUtils.js';

describe('terminateChild', () => {
  it('resolves once a process that honors SIGTERM has actually exited', async () => {
    const child = spawn('sleep', ['30']);
    await new Promise((resolve) => child.once('spawn', resolve));

    const start = Date.now();
    await terminateChild(child as never, 5000);
    const elapsed = Date.now() - start;

    // `sleep` dies on SIGTERM immediately — this must not wait out the grace
    // period. This is the exact bug this helper fixes: the old `dispose()`
    // implementations fired the signal and returned without ever confirming
    // the process was actually gone, so a caller could move on (and a server
    // shut down entirely) while the child was still alive and running.
    expect(elapsed).toBeLessThan(1000);
    expect(child.exitCode === null ? child.signalCode : 'exited').not.toBeNull();
  });

  it('escalates to SIGKILL and still resolves for a process that ignores SIGTERM', async () => {
    // Traps SIGTERM and ignores it, so only SIGKILL can end it — proves the
    // escalation path actually fires and is awaited, not just scheduled.
    const child = spawn('bash', ['-c', "trap '' TERM; sleep 30"]);
    await new Promise((resolve) => child.once('spawn', resolve));
    // Give bash a moment to actually install the trap before sending SIGTERM
    // — otherwise a signal arriving mid-startup can kill it via the default
    // handler before the trap is registered, which is not what this test is
    // exercising.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const start = Date.now();
    await terminateChild(child as never, 300);
    const elapsed = Date.now() - start;

    // Should resolve close to the grace period (SIGKILL escalation), not
    // hang forever and not resolve instantly (SIGTERM alone did nothing).
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(3000);
    expect(child.signalCode).toBe('SIGKILL');
  }, 10_000);

  it('resolves immediately for a process that has already exited', async () => {
    const child = spawn('true', []);
    await new Promise((resolve) => child.once('exit', resolve));

    const start = Date.now();
    await terminateChild(child as never, 5000);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
