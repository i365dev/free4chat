import { defineConfig } from "@playwright/test"

/**
 * Room control-plane E2E (#275): two real browsers against the real local
 * OpenNext Worker + RoomSession Durable Object.
 *
 * The webServer builds the Worker once (`cf-build`) and starts the harness
 * (`run-local-worker.mjs`) which owns: fake Cloudflare Realtime (loopback),
 * the WORKER via createTestHarness(), and the origin-safe 3000 proxy.
 */
export default defineConfig({
  // App-root testDir so CLI spec paths (e2e/room/room.spec.ts) resolve the
  // same way they do for the homepage suite; the testMatch keeps this config
  // scoped to the Room spec only.
  testDir: "../..",
  testMatch: "**/room.spec.ts",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    // config lives in e2e/room; run from the app root so yarn/node_modules
    // resolve normally.
    command:
      "cd ../.. && NEXT_PUBLIC_TURNSTILE_DISABLED=1 yarn cf-build && node e2e/room/run-local-worker.mjs",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 600_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Chromium's built-in fake audio device: getUserMedia returns a REAL
        // MediaStreamTrack, so the Room flow runs on the real media classes
        // without needing real hardware, permissions, or a WebRTC shim.
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
          ],
        },
      },
    },
  ],
})
