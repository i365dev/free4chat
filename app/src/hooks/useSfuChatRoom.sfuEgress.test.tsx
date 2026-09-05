import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@common/utils", async () => {
  const actual = await vi.importActual<typeof import("@common/utils")>(
    "@common/utils"
  )
  return { ...actual, trackAnalyticsEvent: vi.fn() }
})

import { trackAnalyticsEvent } from "@common/utils"

import { useSfuChatRoom } from "./useSfuChatRoom"

class FakeTrack {
  kind: "audio" | "video" = "audio"
  enabled = true
  readyState = "live"
  stop = vi.fn()
}

class FakeDataChannel {
  binaryType = ""
  bufferedAmountLowThreshold = 0
  bufferedAmount = 0
  readyState = "open"
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  connectionState: RTCPeerConnectionState = "new"
  ontrack: ((event: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  getStats = vi.fn().mockResolvedValue(new Map())
  private mids = 0
  private transceivers: { sender: { track: FakeTrack }; mid: string }[] = []

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  addTrack(track: FakeTrack) {
    const mid = String(this.mids++)
    this.transceivers.push({ sender: { track }, mid })
    return { track }
  }
  addTransceiver(
    track: FakeTrack,
    _init: { direction?: "sendonly" | "recvonly" } = {}
  ) {
    const transceiver = { sender: { track }, mid: String(this.mids++) }
    this.transceivers.push(transceiver)
    return transceiver
  }
  getTransceivers() {
    return this.transceivers
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "fake-offer" })
  }
  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "fake-answer" })
  }
  setLocalDescription() {
    return Promise.resolve()
  }
  setRemoteDescription() {
    return Promise.resolve()
  }
  createDataChannel() {
    return new FakeDataChannel()
  }
  removeTrack() {}
  close() {}
}

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor() {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }
  close() {}
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response)
}

describe("useSfuChatRoom SFU egress analytics", () => {
  beforeEach(() => {
    FakePeerConnection.instances.length = 0
    FakeWebSocket.instances.length = 0
    ;(global as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection
    ;(global as unknown as { MediaStream: unknown }).MediaStream = class {
      constructor(_tracks: FakeTrack[] = []) {}
      getAudioTracks() {
        return []
      }
      getTracks() {
        return []
      }
    }
    ;(global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
    Object.defineProperty(global.navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [new FakeTrack()],
        }),
      },
      configurable: true,
    })
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/api/sfu/session"))
        return jsonResponse({
          participantId: "participant-1",
          participantToken: "participant-token",
          sessionId: "session-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      if (url.endsWith("/api/sfu/datachannels/new"))
        return jsonResponse({ dataChannels: [{ id: 1 }] })
      if (url.endsWith("/api/sfu/tracks"))
        return jsonResponse({
          sessionDescription: { type: "answer", sdp: "fake-local-answer" },
          tracks: [{ mid: "0" }],
        })
      return jsonResponse({})
    }) as unknown as typeof fetch
    vi.mocked(trackAnalyticsEvent).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("flushes a leave sample without delaying the leave control message", async () => {
    const stats = vi
      .fn()
      .mockResolvedValueOnce(
        new Map([
          [
            "audio",
            {
              id: "audio",
              type: "inbound-rtp",
              kind: "audio",
              bytesReceived: 100,
            },
          ],
          [
            "video",
            {
              id: "video",
              type: "inbound-rtp",
              kind: "video",
              bytesReceived: 0,
            },
          ],
          ["dc", { id: "dc", type: "data-channel", bytesReceived: 0 }],
        ])
      )
      .mockResolvedValueOnce(
        new Map([
          [
            "audio",
            {
              id: "audio",
              type: "inbound-rtp",
              kind: "audio",
              bytesReceived: 180,
            },
          ],
          [
            "video",
            {
              id: "video",
              type: "inbound-rtp",
              kind: "video",
              bytesReceived: 20,
            },
          ],
          ["dc", { id: "dc", type: "data-channel", bytesReceived: 5 }],
        ])
      )

    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("private-room-id", "Alice", "screenshare")
    )
    await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1))
    const peerConnection = FakePeerConnection.instances[0]
    peerConnection.getStats = stats

    act(() => {
      peerConnection.connectionState = "connected"
      peerConnection.onconnectionstatechange?.()
    })
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(1))

    // The browser-facing leave call is synchronous even though getStats is not.
    act(() => result.current.leaveRoom())
    expect(trackAnalyticsEvent).not.toHaveBeenCalled()
    expect(JSON.parse(FakeWebSocket.instances[0].sent.at(-1) ?? "{}")).toEqual({
      type: "leave",
    })

    await waitFor(() =>
      expect(trackAnalyticsEvent).toHaveBeenCalledWith("SFUEgressSample", {
        roomHash: expect.not.stringMatching("private-room-id"),
        roomType: "screenshare",
        participantBucket: "1",
        audioBytes: 80,
        videoBytes: 20,
        dataChannelBytes: 5,
        totalBytes: 105,
        intervalMs: expect.any(Number),
        sampleReason: "leave",
      })
    )
    const payload = vi.mocked(trackAnalyticsEvent).mock.calls[0]?.[1]
    expect(JSON.stringify(payload)).not.toContain("private-room-id")
    expect(JSON.stringify(payload)).not.toContain("participant-1")
    expect(JSON.stringify(payload)).not.toContain("session-1")
    unmount()
  })

  it("flushes pagehide samples and does not emit zero-delta intervals", async () => {
    const stats = vi
      .fn()
      .mockResolvedValueOnce(
        new Map([
          [
            "audio",
            {
              id: "audio",
              type: "inbound-rtp",
              kind: "audio",
              bytesReceived: 40,
            },
          ],
        ])
      )
      .mockResolvedValueOnce(
        new Map([
          [
            "audio",
            {
              id: "audio",
              type: "inbound-rtp",
              kind: "audio",
              bytesReceived: 40,
            },
          ],
        ])
      )
      .mockResolvedValueOnce(
        new Map([
          [
            "audio",
            {
              id: "audio",
              type: "inbound-rtp",
              kind: "audio",
              bytesReceived: 65,
            },
          ],
        ])
      )

    const { unmount } = renderHook(() =>
      useSfuChatRoom("room-id", "Alice", "audio")
    )
    await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1))
    const peerConnection = FakePeerConnection.instances[0]
    peerConnection.getStats = stats
    act(() => {
      peerConnection.connectionState = "connected"
      peerConnection.onconnectionstatechange?.()
    })
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(1))

    window.dispatchEvent(new Event("pagehide"))
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2))
    expect(trackAnalyticsEvent).not.toHaveBeenCalled()

    window.dispatchEvent(new Event("pagehide"))
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(trackAnalyticsEvent).toHaveBeenCalledWith(
        "SFUEgressSample",
        expect.objectContaining({
          audioBytes: 25,
          totalBytes: 25,
          sampleReason: "pagehide",
        })
      )
    )
    unmount()
  })
})
