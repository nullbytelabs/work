import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the `work serve` web console e2e tests.
 *
 * Scoped tightly to `test/web-e2e/` so it never collects the repo's `node:test`
 * suites (`test/*.test.ts`). The `webServer` boots a real server over a seeded
 * throwaway workspace (see `serve-fixture.ts`) and is reused across tests.
 */
const PORT = Number(process.env.WORK_WEB_E2E_PORT ?? 4399);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./test/web-e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command:
      "node --experimental-strip-types --disable-warning=ExperimentalWarning test/web-e2e/serve-fixture.ts",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
