import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "**/homepage-ui-regression.spec.ts",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3781",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "yarn next build && yarn start -p 3781",
    url: "http://127.0.0.1:3781",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [
    { name: "chromium-homepage-ui", use: { browserName: "chromium" } },
  ],
})
