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
  await expect(page.getByText(new RegExp(nickname)).first()).toBeVisible({
    timeout: 15_000,
  })
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
 * Only used by the Room App host compatibility suite; it is not a production
 * seam and it deliberately does not touch the media transport itself.
 */
export async function installSyntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    const globalWindow = window as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const AudioContextConstructor =
      globalWindow.AudioContext ?? globalWindow.webkitAudioContext
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices || !AudioContextConstructor) return
    mediaDevices.getUserMedia = async (
      constraints?: MediaStreamConstraints
    ): Promise<MediaStream> => {
      if (constraints?.video)
        throw new DOMException(
          "the local fixture has no camera",
          "NotFoundError"
        )
      const context = new AudioContextConstructor()
      const destination = context.createMediaStreamDestination()
      const oscillator = context.createOscillator()
      oscillator.frequency.value = 220
      oscillator.connect(destination)
      oscillator.start()
      return destination.stream
    }
  })
}
