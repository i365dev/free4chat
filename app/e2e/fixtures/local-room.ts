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
  await page.goto(`/room?id=${roomSlug}`)
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
 * Device-free microphone (#398).
 *
 * Playwright's WebKit has no OS audio device and no grantable microphone
 * permission, so `getUserMedia` never settles there, and requiring a real
 * microphone would make the layout gate engine-dependent. This returns a REAL
 * `MediaStream` with a live audio track synthesised from an AudioContext, so
 * the Room reaches its normal joined state on every engine without a prompt.
 *
 * Nothing may be captured at document-start: on Linux WebKit both
 * `navigator.mediaDevices` and `AudioContext` are exposed only once the
 * secure-context origin is fully established, and the first browser of a cold
 * CI run is the slowest. Capturing either one there silently skipped the
 * patch, after which a native `getUserMedia` failed the join with
 * "Invalid constraint" — intermittently, and only in CI.
 *
 * So: resolve AudioContext lazily inside the call, patch whatever exists now
 * (instance, then prototype, then the navigator accessor itself), and re-apply
 * once the document exists. The app only ever calls `getUserMedia`, so owning
 * the accessor outright is safe.
 *
 * Only used by the Room App host compatibility suite; it is not a production
 * seam and it deliberately does not touch the media transport itself.
 */
export async function installSyntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    const globalWindow = window as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
      MediaDevices?: { prototype: MediaDevices }
      __roomAppHostCompatMic?: string
    }

    const syntheticGetUserMedia = async (
      constraints?: MediaStreamConstraints
    ): Promise<MediaStream> => {
      if (constraints?.video)
        throw new DOMException(
          "the local fixture has no camera",
          "NotFoundError"
        )
      const AudioContextConstructor =
        globalWindow.AudioContext ?? globalWindow.webkitAudioContext
      if (!AudioContextConstructor)
        throw new DOMException(
          "the local fixture has no AudioContext",
          "NotSupportedError"
        )
      const context = new AudioContextConstructor()
      const destination = context.createMediaStreamDestination()
      const oscillator = context.createOscillator()
      oscillator.frequency.value = 220
      oscillator.connect(destination)
      oscillator.start()
      return destination.stream
    }

    const syntheticMediaDevices = {
      getUserMedia: syntheticGetUserMedia,
      enumerateDevices: async () => [],
    }

    const ownGetUserMedia = (target: object | undefined): boolean => {
      if (!target) return false
      try {
        Object.defineProperty(target, "getUserMedia", {
          configurable: true,
          writable: true,
          value: syntheticGetUserMedia,
        })
        return true
      } catch {
        return false
      }
    }

    const applyPatch = () => {
      if (
        ownGetUserMedia(navigator.mediaDevices) ||
        ownGetUserMedia(globalWindow.MediaDevices?.prototype)
      ) {
        globalWindow.__roomAppHostCompatMic = "synthetic"
        return
      }
      try {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          get: () => syntheticMediaDevices,
        })
        globalWindow.__roomAppHostCompatMic = "synthetic"
      } catch {
        // Leave the seam marker unset so the spec fails loudly instead of
        // silently joining with a real device.
      }
    }

    applyPatch()
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", applyPatch, { once: true })
  })
}
