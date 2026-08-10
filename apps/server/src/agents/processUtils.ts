import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Sends SIGTERM to a child process, escalating to SIGKILL after `graceMs` if
 * it hasn't exited by then, and resolves only once the process has actually
 * exited.
 *
 * Every harness adapter's `dispose()` used to fire these signals and return
 * immediately without waiting for the child to actually die. That let
 * `runtime.shutdownAll()` — and the whole server's graceful-shutdown
 * sequence in `index.ts` — resolve, and the process call `process.exit()`,
 * while the harness's child (often nested inside a bubblewrap sandbox, which
 * doesn't always forward signals to the sandboxed process promptly) was
 * still genuinely running. A restart landing in that window orphans the
 * child: it keeps mutating the sandbox in the background — a real commit
 * can land — with no live server around to post the chat message or
 * increment `turnCount`. On the next startup, the session just gets marked
 * idle with a generic "The server restarted during this run" error, even
 * though the turn's real work silently finished, unattributed, moments
 * later. Actually awaiting the exit here closes that window: the server's
 * shutdown sequence can't complete (and therefore `process.exit()` can't
 * run) until every child is confirmed gone.
 */
export function terminateChild(
  child: ChildProcessWithoutNullStreams,
  graceMs = 5000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
