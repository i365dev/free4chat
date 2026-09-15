import { defineConfig, devices } from "@playwright/test"

/**
 * Room App host compatibility gate (#398).
 *
 * One Playwright invocation, one local Worker harness (`webServer` starts the
 * harness ONCE and every project shares it), five representative viewports.
 * Media is faked at the page level rather than through browser launch flags so
 * the same configuration is valid for Chromium and WebKit on macOS and Linux.
 * The harness proxies the canonical allowed origin http://localhost:3000, so
 * production origin validation is never weakened.
 *
 * Failure artifacts: screenshot + trace are retained on failure, so a broken
 * tablet layout is diagnosable without a real iPad. No video in v1, and no
 * screenshot baselines — assertions are semantic / geometric.
 */

const DESKTOP_VIEWPORT = { width: 1440, height: 900 }

export default defineConfig({
  // App-root testDir so CLI spec paths resolve like the existing Room suite;
  // testMatch keeps this config scoped to the compatibility spec.
  testDir: "../..",
  testMatch: "**/room-app-host.spec.ts",
  timeout: 90_000,
  // Joining a Room needs a real Worker + Durable Object round trip plus SFU
  // session/channel setup; WebKit on a loaded machine is slower than the
  // geometry assertions themselves.
  expect: { timeout: 30_000 },
  fullyParallel: true,
  // Five projects share ONE local Worker + Durable Object and one loopback
  // Realtime fake. CI runners are small: a single worker keeps the shared
  // harness (and the media/AudioContext seams) deterministic, at the cost of
  // running the five short projects sequentially.
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    // No engine-specific launch flags: the suite installs one synthetic
    // microphone for every project (see e2e/fixtures/local-room.ts), so no
    // profile needs a real device, a permission prompt, or a Chromium-only
    // fake-device flag that Playwright's WebKit rejects on Linux.
  },
  webServer: {
    // config lives in e2e/room-app-host; run from the app root so
    // yarn/node_modules resolve normally. The Worker is built ONCE for all
    // five projects.
    command:
      "cd ../.. && NEXT_PUBLIC_TURNSTILE_DISABLED=1 yarn cf-build && node e2e/room/run-local-worker.mjs",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 600_000,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: DESKTOP_VIEWPORT },
    },
    {
      name: "webkit-desktop",
      use: { ...devices["Desktop Safari"], viewport: DESKTOP_VIEWPORT },
    },
    {
      // Phone-class viewport with touch + mobile viewport behaviour.
      // WebKit emulation is NOT real iOS Safari; see the suite README.
      name: "webkit-phone",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "webkit-tablet-portrait",
      use: {
        ...devices["iPad (gen 7)"],
        viewport: { width: 820, height: 1180 },
      },
    },
    {
      name: "webkit-tablet-landscape",
      use: {
        ...devices["iPad (gen 7) landscape"],
        viewport: { width: 1180, height: 820 },
      },
    },
    {
      // iPad Pro 12.9" portrait sits exactly on Core's `lg` (1024px)
      // breakpoint, where the Room header and several panels change layout.
      name: "webkit-tablet-1024",
      use: {
        ...devices["iPad (gen 7)"],
        viewport: { width: 1024, height: 1366 },
      },
    },
  ],
})
