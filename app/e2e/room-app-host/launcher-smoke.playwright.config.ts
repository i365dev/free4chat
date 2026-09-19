import { defineConfig, devices } from "@playwright/test"

/**
 * #98 launcher visual smoke (NOT a CI gate).
 *
 * Same local Worker harness as the compatibility gate, but two representative
 * viewports and screenshot artifacts instead of baselines: a Human reviews the
 * actual launcher pixels at 1280x800 and at ~390px.
 */
export default defineConfig({
  testDir: "../..",
  testMatch: "**/launcher-smoke.spec.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command:
      "cd ../.. && NEXT_PUBLIC_TURNSTILE_DISABLED=1 yarn cf-build && node e2e/room/run-local-worker.mjs",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 600_000,
  },
  projects: [
    {
      name: "chromium-smoke",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
})
