import mongoose from 'mongoose';
import { config } from './config.js';

mongoose.set('strictQuery', true);

export async function connectDatabase(uri: string = config.mongoUri): Promise<void> {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    // Ensure the indexes declared on the schemas exist. Cheap at this scale and
    // it keeps a fresh deployment correct without a migration step.
    autoIndex: true,
  });
}

/**
 * Connects, retrying transient failures.
 *
 * The database is frequently not reachable the instant this process starts:
 * under Docker the embedded DNS resolver can return `EAI_AGAIN` for a moment
 * after a container joins the network, and a database restarted alongside the
 * app takes a few seconds to accept connections. Exiting on the first failure
 * turns either into a crash loop, so transient errors are retried and only a
 * sustained outage is fatal.
 */
export async function connectDatabaseWithRetry(
  log: { warn: (obj: unknown, msg: string) => void },
  uri: string = config.mongoUri,
  attempts = 30,
  delayMs = 2000,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await connectDatabase(uri);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      log.warn(
        { attempt, of: attempts, err: (error as Error).message },
        'database not reachable yet, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export { mongoose };
