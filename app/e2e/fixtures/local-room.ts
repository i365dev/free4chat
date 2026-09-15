import { expect, type Page } from "@playwright/test"

/**
 * Shared browser-side seams for the local Room E2E suites (#275, #398).
 *
 * Only the media bootstrap is faked: Chromium/WebKit's own fake-device flags
 * provide a REAL `MediaStreamTrack` (no permission prompt), and
 * `RTCPeerConnection` is stubbed because the loopback fake Realtime upstream
 * serves deliberately unparseable SDP and the control-plane / host-lifecycle
 * flows must not depend on real media negotiation.
 */
export async function installMediaShim(page: Page) {
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

/** Enter the nickname gate and reach the joined local Room. */
export async function joinLocalRoom(
  page: Page,
  roomSlug: string,
  nickname: string
): Promise<Page> {
  await installMediaShim(page)
  await openLocalRoom(page, roomSlug)
  await enterLocalRoom(page, nickname)
  return page
}

/** Navigate to the local Room without joining it yet. */
export async function openLocalRoom(
  page: Page,
  roomSlug: string
): Promise<Page> {
  await page.goto(`/room?id=${roomSlug}`)
  return page
}

/** Pass the nickname gate and wait for the joined Room UI. */
export async function enterLocalRoom(
  page: Page,
  nickname: string
): Promise<Page> {
  await page.getByLabel("Nickname").fill(nickname)
  await page.getByRole("button", { name: /Go/i }).click()
  // The room UI is connected once the self participant card renders.
  try {
    await expect(page.getByText(new RegExp(nickname)).first()).toBeVisible({
      // A shared local Worker + Durable Object on a loaded CI runner is slower
      // than the geometry assertions this suite is about.
      timeout: 30_000,
    })
  } catch (error) {
    // Surface the room's own failure text (e.g. an SFU or media error) instead
    // of only a locator timeout: this is what made the first CI failure hard to
    // read from the logs alone.
    const visible = await page
      .evaluate(() =>
        document.body.innerText.replace(/\s+/g, " ").slice(0, 300)
      )
      .catch(() => "")
    throw new Error(
      `Room never reached the joined state for ${nickname}: ${
        visible || String(error)
      }`
    )
  }
  return page
}

/**
 * Microphone-request counter for the #402 automation invariant.
 *
 * Entering a Room must never ask for microphone permission, so the generic
 * Room / Room App E2E suites install this counter and assert it stays at zero.
 * A real request would otherwise only surface as a browser permission prompt,
 * which headless automation silently tolerates.
 */
export async function installMicrophoneCallCounter(page: Page) {
  await page.addInitScript(() => {
    const requests: unknown[] = []
    ;(window as unknown as { __micRequests?: unknown[] }).__micRequests =
      requests
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices) return
    const original = mediaDevices.getUserMedia?.bind(mediaDevices)
    mediaDevices.getUserMedia = (
      ...args: Parameters<MediaDevices["getUserMedia"]>
    ): Promise<MediaStream> => {
      requests.push(args[0] ?? null)
      return original
        ? original(...args)
        : Promise.reject(
            new DOMException("no microphone device", "NotFoundError")
          )
    }
  })
}

export async function microphoneRequestCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __micRequests?: unknown[] }).__micRequests
        ?.length ?? 0
  )
}
