import { assertSecretsAreSafe, config } from './config.js';
import { buildApp } from './app.js';
import { connectDatabaseWithRetry, disconnectDatabase } from './db.js';
import { hub } from './realtime/hub.js';
import { runtime } from './agents/runtime.js';
import { probeBubblewrap } from './sandbox/bubblewrap.js';
import { listHarnessAvailability } from './agents/harnessRegistry.js';
import { AgentSessionModel } from './models/agentSession.js';

async function main(): Promise<void> {
  const app = await buildApp();
  assertSecretsAreSafe(app.log);

  await connectDatabaseWithRetry(app.log);
  app.log.info({ uri: redactMongoUri(config.mongoUri) }, 'connected to MongoDB');

  // Any session that was mid-flight when the process last stopped has no live
  // harness behind it. Marking them idle keeps the UI honest: the sandbox is
  // still there, so the next prompt simply resumes.
  const stranded = await AgentSessionModel.updateMany(
    { status: { $in: ['running', 'waiting_input', 'provisioning'] } },
    { $set: { status: 'idle', lastError: 'The server restarted during this run' } },
  );
  if (stranded.modifiedCount > 0) {
    app.log.warn({ count: stranded.modifiedCount }, 'reset agent sessions stranded by a restart');
  }

  const bubblewrap = await probeBubblewrap();
  if (bubblewrap.available) {
    app.log.info({ version: bubblewrap.version }, 'bubblewrap sandbox ready');
  } else if (config.sandboxEnabled) {
    app.log.error(
      { reason: bubblewrap.reason },
      'bubblewrap is unavailable — agents cannot start until this is fixed',
    );
  } else {
    app.log.warn('sandboxing is disabled; agents will run directly on the host');
  }

  for (const harness of await listHarnessAvailability()) {
    if (harness.available) app.log.info({ version: harness.version }, `${harness.label} available`);
    else app.log.warn(`${harness.label} not found — it will be offered as unavailable`);
  }

  await app.listen({ port: config.port, host: config.host });
  hub.attach(app.server);
  app.log.info(`realtime hub attached; allowed origins: ${config.webOrigins.join(', ')}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await runtime.shutdownAll();
      await hub.close();
      await app.close();
      await disconnectDatabase();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function redactMongoUri(uri: string): string {
  return uri.replace(/\/\/[^@]+@/, '//***@');
}

main().catch((error) => {
  console.error('Failed to start TeamAgents server:', error);
  process.exit(1);
});
