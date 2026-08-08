import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root, whether running from `src/` (tsx) or `dist/` (compiled). */
export const REPO_ROOT = path.resolve(here, '../../..');

/**
 * Minimal .env loader. Avoids a dependency and, unlike dotenv, never overrides
 * variables already present in the real environment.
 */
function loadDotEnv(): void {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function str(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function int(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value !== 'false' && value !== '0' && value !== 'no';
}

const dataDirRaw = str('DATA_DIR', './data');

export const config = {
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',

  port: int('PORT', 4000),
  host: str('HOST', '0.0.0.0'),
  /**
   * Origins allowed to call the API and open a socket, comma-separated.
   *
   * A list rather than a single value because the same deployment is commonly
   * reached by more than one name — localhost during development, a LAN
   * address, a proxied hostname. It stays an allowlist rather than reflecting
   * whatever origin asks, since the socket handshake accepts the session
   * cookie and a reflected origin would let any site open one.
   */
  webOrigins: str('WEB_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  mongoUri: str('MONGODB_URI', 'mongodb://127.0.0.1:27017/teamagents'),

  jwtSecret: str('JWT_SECRET', 'dev-only-change-me-jwt-secret'),
  /** Master key for AES-256-GCM encryption of stored git credentials. */
  credentialSecret: str('TEAMAGENTS_SECRET', 'dev-only-change-me-credential-encryption-secret'),

  dataDir: path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(REPO_ROOT, dataDirRaw),
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),

  /**
   * Built web assets to serve alongside the API. Present in a container or any
   * single-process deployment; absent in development, where Vite serves the app
   * and proxies /api here.
   */
  webDist: (() => {
    const raw = str('WEB_DIST', path.join(REPO_ROOT, 'apps/web/dist'));
    return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
  })(),

  sandboxEnabled: bool('SANDBOX_ENABLED', true),
  bwrapBin: str('BWRAP_BIN', ''),
  /**
   * Share package/tool caches between sandboxes of the same harness. Sandboxes
   * are permanent, so without this every session keeps its own copy of whatever
   * its harness downloads — close to a gigabyte each for some of them.
   */
  shareAgentCaches: bool('SHARE_AGENT_CACHES', true),

  harnessBins: {
    'claude-code': str('CLAUDE_BIN', ''),
    codex: str('CODEX_BIN', ''),
    opencode: str('OPENCODE_BIN', ''),
  } as Record<string, string>,

  /**
   * Optional model override for OpenCode, as `provider/model` (for example
   * `opencode/deepseek-v4-flash`). A sandbox has its own home, so OpenCode
   * falls back to its built-in default rather than whatever the operator uses
   * interactively; setting this pins it and makes runs reproducible.
   */
  opencodeModel: str('OPENCODE_MODEL', ''),

  /**
   * Where to read harness logins from when seeding a sandbox. Defaults to the
   * server user's home directory, which is what you want on a normal host. In a
   * container it lets the operator's real credentials be mounted somewhere
   * read-only instead of being copied into the image.
   */
  harnessCredentialsDir: str('HARNESS_CREDENTIALS_DIR', ''),

  /** Provider keys forwarded into the sandbox so harnesses can authenticate. */
  providerEnv: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  } as Record<string, string>,
} as const;

export const paths = {
  uploads: path.join(config.dataDir, 'uploads'),
  sandboxes: path.join(config.dataDir, 'sandboxes'),
};

/** Warns loudly when production is running on the shipped development secrets. */
export function assertSecretsAreSafe(log: { warn: (msg: string) => void }): void {
  if (!config.isProduction) return;
  if (config.jwtSecret.startsWith('dev-only-change-me')) {
    log.warn('JWT_SECRET is still the development default — set it in .env');
  }
  if (config.credentialSecret.startsWith('dev-only-change-me')) {
    log.warn('TEAMAGENTS_SECRET is still the development default — set it in .env');
  }
}
