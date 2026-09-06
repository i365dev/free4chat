import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

/**
 * Room control-plane E2E (#275) — two REAL browser pages, one REAL local
 * Worker, one REAL RoomSession Durable Object.
 *
 * What is real: browser UI, OpenNext Worker routes, RoomSession DO, ROOMS_KV,
 * WebSocket (/api/sfu/ws), participant registration, roster broadcasts, text
 * messages.
 * What is fake: the Cloudflare Realtime upstream (loopback server configured
 * via SFU_RTC_BASE_URL) and the browser media bootstrap (shim below).
 *
 * The message below MUST travel browser -> WebSocket -> DO -> broadcast ->
 * other browser; nothing is seeded into the DO directly.
 */
const ROOM_SLUG = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const MESSAGE = "hello from alice"

// Media bootstrap: chromium launch args provide a REAL fake-device
// MediaStreamTrack (no permission prompt). The RTCPeerConnection is a stub
// because the fake SFU's SDP is deliberately not parseable and the Room
// control-plane flow must not depend on media negotiation.
async function installMediaShim(page: Page) {
  await page.addInitScript(() => {
    class FakeRTCPeerConnection {
      onicecandidate = null
      ontrack = null
      ondatachannel = null
      __transceivers: Array<{
        sender: { track: unknown }
        receiver: { track: null }
        mid: string
        direction: string
      }> = []
      addTrack() {
        return { mid: "0", direction: "sendonly" }
      }
      addTransceiver(track: unknown, init: { direction?: string } = {}) {
        const transceiver = {
          sender: { track },
          receiver: { track: null },
          mid: "0",
          direction: init?.direction ?? "sendrecv",
        }
        this.__transceivers.push(transceiver)
        return transceiver
      }
      createDataChannel(label: string) {
        return {
          label,
          readyState: "open",
          bufferedAmount: 0,
          bufferedAmountLowThreshold: 0,
          send() {},
          close() {},
          addEventListener() {},
          removeEventListener() {},
        }
      }
      createOffer() {
        return Promise.resolve({ type: "offer", sdp: "v=0\r\n" })
      }
      createAnswer() {
        return Promise.resolve({ type: "answer", sdp: "v=0\r\n" })
      }
      setLocalDescription() {
        return Promise.resolve()
      }
      setRemoteDescription() {
        return Promise.resolve()
      }
      getTransceivers() {
        return this.__transceivers
      }
      getConfiguration() {
        return { iceServers: [] }
      }
      getStats() {
        return Promise.resolve(new Map())
      }
      getSenders() {
        return []
      }
      getReceivers() {
        return []
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    ;(window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakeRTCPeerConnection
  })
}

/** Enter the nickname gate and reach the joined room. */
async function joinRoom(page: Page, nickname: string) {
  await installMediaShim(page)
  await page.goto(`/room?id=${ROOM_SLUG}`)
  await page.getByLabel("Nickname").fill(nickname)
  await page.getByRole("button", { name: /Go/i }).click()
  // The room UI is connected once the self participant card renders.
  await expect(page.getByText(new RegExp(nickname)).first()).toBeVisible({
    timeout: 15_000,
  })
  return page
}

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

  await joinRoom(pageA, "Alice")
  await joinRoom(pageB, "Bob")

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

  // Hard invariant (#275 review): every Cloudflare Realtime request made
  // during the test must have been explicitly handled by the loopback fake.
  // The fake never forwards anything — an unexpected outbound call would
  // have 503'd here AND be recorded for this assertion, even when
  // best-effort production semantics would swallow the failure.
  const stateDir =
    process.env.FREEF4CHAT_E2E_STATE_DIR ??
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

  await contextA.close()
  await contextB.close()
  void testInfo
})
