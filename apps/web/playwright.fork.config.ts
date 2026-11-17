import { defineConfig, devices } from '@playwright/test';

/**
 * Fork happy path (`pnpm --filter web e2e:fork`). Started by e2e/fork/run.ts, which brings up a fresh anvil fork,
 * the worker, the API and an isolated web dev server, and passes their URLs in E2E_* variables.
 */
export default defineConfig({
  testDir: './e2e/fork',
  timeout: 300_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3005',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
    ...devices['Desktop Chrome'],
    viewport: { width: 1360, height: 900 },
  },
});
