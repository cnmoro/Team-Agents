/**
 * Brings up (or verifies) the standalone QA lab used for realistic, hands-on
 * testing: a dedicated server instance, its own database, and a local git
 * daemon serving a real repository agents can clone and edit.
 *
 * Deliberately separate from both the dev workflow and the Docker deployment
 * shown to the user — this is a throwaway-but-persistent environment for
 * simulating real usage without polluting either of those with generated test
 * data. State lives under `data/qa/` and `data/qa-gitserver/`, both
 * gitignored, so it survives process restarts but never reaches git.
 *
 * Idempotent: safe to run every time a QA pass starts. Only starts what isn't
 * already running.
 *
 *   node scripts/qa/bootstrap.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GIT_PORT = 9418;
const APP_PORT = 4200;
const GITSERVER_DIR = path.join(ROOT, 'data/qa-gitserver');
const REPOS_DIR = path.join(GITSERVER_DIR, 'repos');
const DEMO_REPO = path.join(REPOS_DIR, 'demo.git');

async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function daemonize(command, args, opts) {
  const child = spawn(command, args, { ...opts, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

async function ensureDemoRepo() {
  if (existsSync(DEMO_REPO)) return;
  console.log('Seeding the demo repository...');
  await mkdir(REPOS_DIR, { recursive: true });
  const work = path.join(GITSERVER_DIR, 'work');
  await mkdir(path.join(work, 'src'), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(work, 'README.md'),
    '# Demo Service\n\nA tiny service used to QA-test the TeamAgents platform.\n',
  );
  await writeFile(
    path.join(work, 'src/greeter.py'),
    'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n',
  );
  const run = (cmd, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}`))));
    });
  await run('git', ['init', '-q'], work);
  await run('git', ['config', 'user.email', 'seed@qa.local'], work);
  await run('git', ['config', 'user.name', 'QA Seed'], work);
  await run('git', ['add', '-A'], work);
  await run('git', ['commit', '-q', '-m', 'Initial commit: greeter service'], work);
  await run('git', ['clone', '-q', '--bare', work, DEMO_REPO], GITSERVER_DIR);
}

async function ensureGitDaemon() {
  const reachable = await new Promise((resolve) => {
    const child = spawn('git', ['ls-remote', `git://127.0.0.1:${GIT_PORT}/demo.git`], {
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 3000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  if (reachable) {
    console.log(`git daemon already serving on :${GIT_PORT}`);
    return;
  }
  await ensureDemoRepo();
  console.log(`Starting git daemon on :${GIT_PORT}...`);
  daemonize(
    'git',
    ['daemon', '--reuseaddr', `--base-path=${REPOS_DIR}`, '--export-all', `--port=${GIT_PORT}`, REPOS_DIR],
    { cwd: ROOT },
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function ensureApp() {
  if (await isUp(`http://127.0.0.1:${APP_PORT}/api/health`)) {
    console.log(`QA app already serving on :${APP_PORT}`);
    return;
  }
  const distEntry = path.join(ROOT, 'apps/server/dist/index.js');
  if (!existsSync(distEntry)) {
    throw new Error('apps/server/dist/index.js is missing — run `npm run build` first.');
  }
  console.log(`Starting QA app on :${APP_PORT}...`);
  daemonize('node', [distEntry], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      MONGODB_URI: 'mongodb://127.0.0.1:27017/teamagents_qa',
      DATA_DIR: './data/qa',
      WEB_ORIGIN: `http://127.0.0.1:${APP_PORT}`,
    },
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await isUp(`http://127.0.0.1:${APP_PORT}/api/health`)) break;
  }
}

async function ensureSeeded() {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'ada@teamagents.dev', password: 'password123' }),
  }).catch(() => null);
  if (res?.ok) {
    console.log('QA users already seeded.');
    return;
  }
  console.log('Seeding QA demo users...');
  await new Promise((resolve, reject) => {
    const child = spawn('node', ['apps/server/src/scripts/seed.ts'], {
      cwd: ROOT,
      env: { ...process.env, MONGODB_URI: 'mongodb://127.0.0.1:27017/teamagents_qa' },
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))));
  }).catch(async () => {
    // The seed script is TypeScript; fall back to tsx if plain node can't run it.
    await new Promise((resolve, reject) => {
      const child = spawn('npx', ['tsx', 'apps/server/src/scripts/seed.ts'], {
        cwd: ROOT,
        env: { ...process.env, MONGODB_URI: 'mongodb://127.0.0.1:27017/teamagents_qa' },
        stdio: 'inherit',
      });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))));
    });
  });
}

async function main() {
  await ensureGitDaemon();
  await ensureApp();
  await ensureSeeded();
  console.log(`\nQA lab ready:`);
  console.log(`  app:        http://127.0.0.1:${APP_PORT}  (ada@teamagents.dev / password123)`);
  console.log(`  git daemon: git://127.0.0.1:${GIT_PORT}/demo.git`);
}

await main();
