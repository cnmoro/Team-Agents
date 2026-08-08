import type { FastifyInstance } from 'fastify';
import type { SystemStatus } from '@teamagents/shared';
import { config } from '../config.js';
import { requireAuth } from '../services/auth.js';
import { listHarnessAvailability } from '../agents/harnessRegistry.js';
import { probeBubblewrap } from '../sandbox/bubblewrap.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  /** Unauthenticated liveness probe. */
  app.get('/api/health', async () => ({ ok: true }));

  /**
   * Drives the settings screen and greys out harnesses that are not installed,
   * so a user finds out before typing a prompt rather than after.
   */
  app.get('/api/system/status', { preHandler: requireAuth }, async (): Promise<SystemStatus> => {
    const [bubblewrap, harnesses] = await Promise.all([
      probeBubblewrap(),
      listHarnessAvailability(),
    ]);
    return {
      sandboxEnabled: config.sandboxEnabled,
      bubblewrap,
      harnesses,
      dataDir: config.dataDir,
      maxUploadBytes: config.maxUploadBytes,
    };
  });
}
