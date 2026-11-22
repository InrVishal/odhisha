import { defineConfig, devices } from "@playwright/test";

/**
 * - Locally: builds must exist (`npm run build`); Playwright starts
 *   `next start` on port 3300 against a throwaway in-memory database.
 * - CI: E2E_BASE_URL points at the Vercel preview, and the Vercel
 *   protection-bypass header is sent if configured.
 *
 *   npm run test:e2e                        # every browser project
 *   npm run test:a11y                       # accessibility + keyboard only
 *   npx playwright test --project=chromium  # one browser
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3300";
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // One local server serves every browser; more workers just cause timeouts.
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    extraHTTPHeaders: bypass ? { "x-vercel-protection-bypass": bypass } : {},
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node node_modules/next/dist/bin/next start -p 3300",
        url: "http://127.0.0.1:3300/api/health",
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          NODE_ENV: "production",
          DATABASE_URL: "pglite:memory",
          AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-only-not-a-secret-e2e-only-not-a-secret",
          CRON_SECRET: process.env.CRON_SECRET ?? "e2e-only-not-a-secret-e2e-only-not-a-secret",
          EMAIL_TRANSPORT: "console",
          RATE_LIMIT_BACKEND: "memory",
        },
      },
});
