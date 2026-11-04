import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";

// Tests run against an isolated Neon branch (".env.staging"), never the production database.
const stagingUrl = readFileSync(".env.staging", "utf8").match(/^DATABASE_URL=(.*)$/m)![1].trim();
export const E2E = {
  base: "http://localhost:3100",
  ownerEmail: "owner@e2e.test",
  setupToken: "e2e-setup-token-0123456789",
  cron: "e2e-cron-secret-0123456789",
};

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 150_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["json", { outputFile: "e2e/results.json" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: E2E.base, trace: "retain-on-failure", screenshot: "only-on-failure", ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "npx next build && npx next start -p 3100",
    url: `${E2E.base}/login`,
    timeout: 600_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: stagingUrl, BETTER_AUTH_URL: E2E.base, BETTER_AUTH_SECRET: "e2e-auth-secret-0123456789-0123456789",
      OWNER_EMAIL: E2E.ownerEmail, SETUP_TOKEN: E2E.setupToken, CRON_SECRET: E2E.cron, TOKEN_ENCRYPTION_KEY: "e2e", WEBHOOK_URL: "",
    },
  },
});
