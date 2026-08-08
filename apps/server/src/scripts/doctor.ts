/**
 * Environment check. Run with `npm run doctor` before the first start to find
 * out what works and what needs installing, without deciphering server logs.
 */
import { config, paths } from '../config.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { probeBubblewrap } from '../sandbox/bubblewrap.js';
import { listHarnessAvailability, resolveHarness } from '../agents/harnessRegistry.js';

const ok = (message: string) => console.log(`  \u001b[32m✓\u001b[0m ${message}`);
const warn = (message: string) => console.log(`  \u001b[33m!\u001b[0m ${message}`);
const fail = (message: string) => console.log(`  \u001b[31m✗\u001b[0m ${message}`);

async function main(): Promise<void> {
  let problems = 0;

  console.log('\nTeamAgents environment check\n');

  console.log('Configuration');
  ok(`data directory: ${config.dataDir}`);
  ok(`uploads: ${paths.uploads}`);
  ok(`sandboxes: ${paths.sandboxes}`);
  ok(`upload cap: ${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB`);
  if (config.jwtSecret.startsWith('dev-only-change-me')) {
    warn('JWT_SECRET is the development default — set it before deploying');
  }
  if (config.credentialSecret.startsWith('dev-only-change-me')) {
    warn('TEAMAGENTS_SECRET is the development default — set it before storing real credentials');
  }

  console.log('\nDatabase');
  try {
    await connectDatabase();
    ok(`MongoDB reachable at ${config.mongoUri.replace(/\/\/[^@]+@/, '//***@')}`);
    await disconnectDatabase();
  } catch (error) {
    fail(`MongoDB unreachable: ${(error as Error).message}`);
    warn('Start it with: mongod --dbpath ./data/mongo');
    problems++;
  }

  console.log('\nSandbox');
  const bubblewrap = await probeBubblewrap();
  if (bubblewrap.available) {
    ok(`bubblewrap works (${bubblewrap.version})`);
  } else if (config.sandboxEnabled) {
    fail(bubblewrap.reason ?? 'bubblewrap unavailable');
    warn('Install it (apt install bubblewrap) or set SANDBOX_ENABLED=false to run unsandboxed');
    problems++;
  } else {
    warn('sandboxing is disabled; agents will run directly on the host');
  }

  console.log('\nAgent harnesses');
  const availability = await listHarnessAvailability(true);
  for (const harness of availability) {
    if (!harness.available) {
      warn(`${harness.label}: not installed — it will appear greyed out`);
      continue;
    }
    const install = await resolveHarness(harness.id, false);
    ok(`${harness.label}: ${harness.version ?? 'unknown version'}`);
    console.log(`      binary: ${install?.binPath}`);
    console.log(`      mounted: ${install?.installRoot}`);
  }
  if (availability.every((h) => !h.available)) {
    fail('No agent harness is installed; the agent features cannot be used');
    problems++;
  }

  console.log(
    problems === 0
      ? '\nEverything looks good.\n'
      : `\n${problems} problem(s) need attention.\n`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('doctor failed:', error);
  process.exit(1);
});

