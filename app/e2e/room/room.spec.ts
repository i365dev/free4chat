import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import {
  installMicrophoneCallCounter,
  joinLocalRoom,
  microphoneRequestCount,
} from "../fixtures/local-room"

/**
 * Room control-plane E2E (#275) — two REAL browser pages, one REAL local
 * Worker, one REAL RoomSession Durable Object.
 *
 * What is real: browser UI, OpenNext Worker routes, RoomSession DO, ROOMS_KV,
 * WebSocket (/api/sfu/ws), participant registration, roster broadcasts, text
 * messages.
 * What is fake: the Cloudflare Realtime upstream (loopback server configured
 * via SFU_RTC_BASE_URL) and the browser media bootstrap (shared
 * e2e/fixtures/local-room.ts seam).
 *
 * The message below MUST travel browser -> WebSocket -> DO -> broadcast ->
 * other browser; nothing is seeded into the DO directly.
 */
const ROOM_SLUG = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const MESSAGE = "hello from alice"

test("two browsers exchange a text message through the real local DO", async ({
  browser,
}, testInfo) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  let controlConnections = 0
  let disconnectControl: (() => void) | undefined
  await pageA.routeWebSocket(/\/api\/sfu\/ws(?:\?|$)/, (socket) => {
    const upstream = socket.connectToServer()
    controlConnections += 1
    disconnectControl = () => {
      socket.close({ code: 1012, reason: "migration reconnect probe" })
      upstream.close({ code: 1012 })
    }
  })

  const errors: Array<string> = []
  const httpFailures: Array<{ path: string; status: number; phase: string }> =
    []
  let phase = "join"
  let releaseCleanup!: () => void
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })
  // Hold best-effort unmount cleanup until the Room has revoked Bob.
  // A 401 for this deliberately late request is the correct security result.
  await pageB.route("**/api/sfu/datachannels/close", async (route) => {
    if (phase === "leave") await cleanupGate
    await route.continue()
  })
  for (const page of [pageA, pageB]) {
    page.on("response", (response) => {
      if (response.status() >= 400)
        httpFailures.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
          phase,
        })
    })
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
    page.on("console", (message) => {
      if (message.type() !== "error") return
      const resource = message.location().url
      const pathname = resource ? new URL(resource).pathname : ""
      if (
        page === pageB &&
        phase === "leave" &&
        pathname === "/api/sfu/datachannels/close" &&
        message.text() ===
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
      )
        return
      errors.push(`console.error: ${message.text()}`)
    })
  }

  // #402: this is a non-voice Room flow; joining must never request a
  // microphone, so no synthetic device is installed and the counter must stay 0.
  for (const page of [pageA, pageB]) await installMicrophoneCallCounter(page)
  await joinLocalRoom(pageA, ROOM_SLUG, "Alice")
  await joinLocalRoom(pageB, ROOM_SLUG, "Bob")
  expect(await microphoneRequestCount(pageA)).toBe(0)
  expect(await microphoneRequestCount(pageB)).toBe(0)

  // Roster: both pages see both participants.
  await expect(pageA.getByText(/Bob/).first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(pageB.getByText(/Alice/).first()).toBeVisible({
    timeout: 20_000,
  })

  // Alice sends one text message.
  await pageA.getByPlaceholder("Message the room or @ an Agent…").fill(MESSAGE)
  await pageA.keyboard.press("Enter")

  // Bob renders Alice's message — it crossed the real WS/DO path.
  await expect(pageB.getByText(MESSAGE).first()).toBeVisible({
    timeout: 15_000,
  })

  // Drop the actual control connection without reloading either browser.
  // Recovery must reconnect to the Worker/DO and preserve normal messaging.
  expect(disconnectControl).toBeDefined()
  phase = "reconnect"
  const reconnectedFrame = pageA
    .waitForEvent("websocket")
    .then((socket) => socket.waitForEvent("framereceived"))
  disconnectControl!()
  await reconnectedFrame
  expect(controlConnections).toBeGreaterThan(1)
  const recoveredMessage = "hello after control reconnect"
  await pageA
    .getByPlaceholder("Message the room or @ an Agent…")
    .fill(recoveredMessage)
  await pageA.keyboard.press("Enter")
  await expect(pageB.getByText(recoveredMessage).first()).toBeVisible({
    timeout: 15_000,
  })

  // Cheap roster-propagates check: Bob leaves, Alice's roster drops to one.
  phase = "leave"
  const revokedCleanup = pageB.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sfu/datachannels/close" &&
      response.request().method() === "PUT"
  )
  await pageB.getByRole("button", { name: "Leave" }).first().click()
  await expect(pageA.getByText("Bob").first()).toBeHidden({
    timeout: 15_000,
  })
  releaseCleanup()
  expect((await revokedCleanup).status()).toBe(401)

  expect(errors, JSON.stringify(httpFailures)).toEqual([])
  // Neither page ever asked for microphone permission during the whole session.
  expect(await microphoneRequestCount(pageA)).toBe(0)
  expect(await microphoneRequestCount(pageB)).toBe(0)

  // Hard invariant (#275 review): every Cloudflare Realtime request made
  // during the test must have been explicitly handled by the loopback fake.
  // The fake never forwards anything — an unexpected outbound call would
  // have 503'd here AND be recorded for this assertion, even when
  // best-effort production semantics would swallow the failure.
  const stateDir =
    process.env.FREE4CHAT_E2E_STATE_DIR ??
    path.join(os.tmpdir(), "f4c-room-e2e")
  const fakePort = fs
    .readFileSync(path.join(stateDir, "fake-port.txt"), "utf8")
    .trim()
  const audit = (await (
    await fetch(`http://127.0.0.1:${fakePort}/__fake/requests`)
  ).json()) as {
    requests: Array<{ method: string; path: string }>
    unexpected: Array<{ method: string; path: string }>
  }
  expect(
    audit.unexpected,
    "the app made an unexpected Cloudflare Realtime request during the E2E"
  ).toEqual([])
  expect(
    audit.requests.some(
      (request) =>
        request.method === "POST" && request.path.endsWith("/sessions/new")
    ),
    "the fake Realtime must have served the Human join path"
  ).toBe(true)

  // The running harness owns its port/pid files and removes them on shutdown;
  // deleting them here would break a later spec or repeated lifecycle probe.

  await contextA.close()
  await contextB.close()
  void testInfo
})
