import { defineConfig } from "@playwright/test"

/**
 * Real-browser regression for the homepage signal-collapse headline.
 * Deliberately NOT wired into CI: the suite is a manually/optionally run
 * production-behavior check. To run:
 *   npm i -D playwright && npx playwright install chromium
 *   npx playwright test e2e/signal-collapse.spec.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/signal-collapse.spec.ts",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3780",
  },
  webServer: {
    command: "yarn dev -p 3780",
    url: "http://127.0.0.1:3780",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
})
