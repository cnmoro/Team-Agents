import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the real stack: MongoDB, the Fastify server, and
 * the Vite dev server. Nothing is mocked — the point of these tests is to prove
 * the pieces work together.
 *
 * Start the stack yourself with `npm run dev` (and have mongod running), or let
 * Playwright start the web server for you.
 */
/**
 * Point the suite at an already-running deployment — the Docker stack, for
 * example — by setting E2E_BASE_URL. Playwright then skips starting Vite.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const usesExternalServer = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: './e2e',
  // Agent runs call real model providers and are slow by nature.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: usesExternalServer
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://127.0.0.1:5173',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
