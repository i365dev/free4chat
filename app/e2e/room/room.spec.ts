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

  const errors: Array<string> = []
  for (const page of [pageA, pageB]) {
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
    page.on("console", (message) => {
      if (message.type() === "error")
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

  // Cheap roster-propagates check: Bob leaves, Alice's roster drops to one.
  await pageB.getByRole("button", { name: "Leave" }).first().click()
  await expect(pageA.getByText("Bob").first()).toBeHidden({
    timeout: 15_000,
  })

  expect(errors).toEqual([])
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

  // Leave no harness state behind: the next run starts from a clean dir.
  // (Playwright's webServer teardown may SIGKILL the harness before its own
  // SIGTERM cleanup runs; the spec is the last reader of this state.)
  fs.rmSync(stateDir, { recursive: true, force: true })

  await contextA.close()
  await contextB.close()
  void testInfo
})
