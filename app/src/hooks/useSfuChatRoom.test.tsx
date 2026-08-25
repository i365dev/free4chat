import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useSfuChatRoom } from "./useSfuChatRoom"

class FakeTrack {
  enabled = true
  readyState = "live"
  stop = vi.fn()
}

class FakeDataChannel {
  binaryType = ""
  bufferedAmountLowThreshold = 0
  bufferedAmount = 0
  readyState = "open"
  listeners = new Map<string, Set<(event: unknown) => void>>()
  send = vi.fn()
  close = vi.fn()
  addEventListener(type: string, handler: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(handler)
  }
  removeEventListener(type: string, handler: (event: unknown) => void) {
    this.listeners.get(type)?.delete(handler)
  }
}

class FakePeerConnection {
  connectionState = "new"
  ontrack: ((event: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  private mids = 0
  private transceivers: { sender: { track: FakeTrack }; mid: string }[] = []

  addTrack(track: FakeTrack) {
    const mid = String(this.mids++)
    this.transceivers.push({ sender: { track }, mid })
    return { track }
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

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response)
}

describe("useSfuChatRoom — Turnstile boundary", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let getUserMedia: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(global as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection
    class FakeMediaStream {
      private tracks: FakeTrack[]
      constructor(tracks: FakeTrack[] = []) {
        this.tracks = tracks
      }
      getAudioTracks() {
        return this.tracks
      }
      getTracks() {
        return this.tracks
      }
    }
    ;(global as unknown as { MediaStream: unknown }).MediaStream =
      FakeMediaStream
    class FakeWebSocket {
      static OPEN = 1
      readyState = 1
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: (() => void) | null = null
      constructor(public url: string) {}
      send() {}
      close() {}
    }
    ;(global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket

    getUserMedia = vi.fn().mockResolvedValue({
      getAudioTracks: () => [new FakeTrack()],
    })
    Object.defineProperty(global.navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    })

    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/api/sfu/session")) {
        return jsonResponse({
          participantId: "participant-1",
          participantToken: "participant-token",
          sessionId: "session-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      }
      if (url.endsWith("/api/sfu/datachannels/establish")) {
        return jsonResponse({})
      }
      if (url.endsWith("/api/sfu/datachannels/new")) {
        return jsonResponse({ dataChannels: [{ id: 1 }] })
      }
      if (url.endsWith("/api/sfu/tracks")) {
        return jsonResponse({})
      }
      return jsonResponse({})
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("requests a fresh Turnstile token before creating a new Human session, and sends it to /api/sfu/session", async () => {
    const getTurnstileToken = vi.fn().mockResolvedValue("fresh-token")

    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("room-a", "alice", "audio", { getTurnstileToken })
    )

    await waitFor(() => expect(getTurnstileToken).toHaveBeenCalledTimes(1))

    // Verification must happen before the microphone is ever requested.
    const tokenCallOrder = getTurnstileToken.mock.invocationCallOrder[0]
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))
    const mediaCallOrder = getUserMedia.mock.invocationCallOrder[0]
    expect(tokenCallOrder).toBeLessThan(mediaCallOrder)

    await waitFor(
      () => {
        const sessionCall = fetchMock.mock.calls.find(([input]) =>
          String(input).endsWith("/api/sfu/session")
        )
        if (!sessionCall) {
          throw new Error(
            `no session call yet; status=${
              result.current.connectionStatus
            } error=${result.current.error} fetchCalls=${fetchMock.mock.calls
              .map(([i]) => String(i))
              .join(",")}`
          )
        }
        const body = JSON.parse(sessionCall[1].body as string)
        expect(body.turnstileToken).toBe("fresh-token")
        expect(body.reconnect).toBeUndefined()
      },
      { timeout: 3000 }
    )

    expect(result.current.connectionStatus).not.toBe("verification_failed")
    unmount()
  })

  it("moves to verification_failed (not a hard failure) when the challenge fails, without ever requesting the microphone", async () => {
    const getTurnstileToken = vi
      .fn()
      .mockRejectedValue(new Error("turnstile_error"))

    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("room-b", "bob", "audio", { getTurnstileToken })
    )

    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("verification_failed")
    )
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/api/sfu/session")
      )
    ).toBe(false)

    unmount()
  })

  it("never persists a Turnstile token to sessionStorage or localStorage", async () => {
    const getTurnstileToken = vi.fn().mockResolvedValue("fresh-token")
    const { unmount } = renderHook(() =>
      useSfuChatRoom("room-c", "carol", "audio", { getTurnstileToken })
    )

    await waitFor(() => expect(getTurnstileToken).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/sfu/session")
        )
      ).toBe(true)
    )

    expect(sessionStorage.getItem("ts_token")).toBeNull()
    expect(localStorage.getItem("ts_token")).toBeNull()

    unmount()
  })

  it("does not request a Turnstile token at all when the caller provides no getTurnstileToken", async () => {
    const { unmount } = renderHook(() =>
      useSfuChatRoom("room-d", "dave", "audio", {})
    )

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/sfu/session")
        )
      ).toBe(true)
    )
    const sessionCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/sfu/session")
    )
    const body = JSON.parse(sessionCall![1].body as string)
    expect(body.turnstileToken).toBeUndefined()

    unmount()
  })
})

describe("useSfuChatRoom room attachments (#123)", () => {
  class RecordingWebSocket {
    static OPEN = 1
    static instances: RecordingWebSocket[] = []
    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    sent: string[] = []
    constructor(public url: string) {
      RecordingWebSocket.instances.push(this)
    }
    send(data: string) {
      this.sent.push(data)
    }
    close() {}
  }

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(global as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection
    class FakeMediaStream {
      private tracks: FakeTrack[]
      constructor(tracks: FakeTrack[] = []) {
        this.tracks = tracks
      }
      getAudioTracks() {
        return this.tracks
      }
      getTracks() {
        return this.tracks
      }
    }
    ;(global as unknown as { MediaStream: unknown }).MediaStream =
      FakeMediaStream
    RecordingWebSocket.instances.length = 0
    ;(global as unknown as { WebSocket: unknown }).WebSocket =
      RecordingWebSocket

    const getUserMedia = vi.fn().mockResolvedValue({
      getAudioTracks: () => [new FakeTrack()],
    })
    Object.defineProperty(global.navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    })

    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/api/sfu/session")) {
        return jsonResponse({
          participantId: "participant-1",
          participantToken: "participant-token",
          sessionId: "session-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      }
      if (url.endsWith("/api/sfu/datachannels/establish")) {
        return jsonResponse({})
      }
      if (url.endsWith("/api/sfu/datachannels/new")) {
        return jsonResponse({ dataChannels: [{ id: 1 }] })
      }
      if (url.endsWith("/api/sfu/tracks")) {
        return jsonResponse({})
      }
      if (url.endsWith("/api/room/attachments")) {
        return jsonResponse({
          attachment: {
            id: "att-123",
            fileName: "app.log",
            mimeType: "text/plain",
            size: 5,
          },
        })
      }
      return jsonResponse({})
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function connect(room: string) {
    const rendered = renderHook(() =>
      useSfuChatRoom(room, "uploader", "audio", {})
    )
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/sfu/session")
        )
      ).toBe(true)
    )
    return rendered
  }

  function makeLogFile() {
    return new File(["line"], "app.log", { type: "" })
  }

  it("uploads .log text artifacts with the authoritative MIME from agentTextMime", async () => {
    const { result, unmount } = await connect("room-attach-a")
    const uploaded = await waitFor(() =>
      result.current.uploadRoomAttachment(makeLogFile())
    )
    expect(uploaded.id).toBe("att-123")
    const attachCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/room/attachments")
    )
    const headers = attachCall![1].headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("text/plain")
    unmount()
  })

  it("wires upload metadata id into sendCollabRequest attachmentIds over an open socket", async () => {
    const { result, unmount } = await connect("room-attach-b")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const uploaded = await waitFor(() =>
      result.current.uploadRoomAttachment(makeLogFile())
    )
    const requestId = result.current.sendCollabRequest(
      "agent-b",
      "Check the logs",
      [uploaded.id]
    )
    expect(requestId).not.toBe("")
    const ws = RecordingWebSocket.instances.at(-1)!
    const envelopes = ws.sent.map(
      (raw) => JSON.parse(raw) as Record<string, unknown>
    )
    const envelope = envelopes.find((m) => m.type === "collab-request")
    expect(envelope).toBeTruthy()
    expect(envelope?.["attachmentIds"]).toEqual([uploaded.id])
    expect(envelope?.["targetParticipantId"]).toBe("agent-b")
    unmount()
  })

  it("sends nothing when the WebSocket is not open", async () => {
    class ClosedSocket extends RecordingWebSocket {
      readyState = 3
    }
    ;(global as unknown as { WebSocket: unknown }).WebSocket = ClosedSocket
    RecordingWebSocket.instances.length = 0
    const { result, unmount } = await connect("room-attach-c")
    expect(result.current.sendCollabRequest("agent-b", "hi")).toBe("")
    const ws = RecordingWebSocket.instances.at(-1)!
    expect(ws.sent).toEqual([])
    unmount()
  })

  it("surfaces upload failures from the shared response path", async () => {
    const { result, unmount } = await connect("room-attach-d")
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/api/room/attachments")) {
        return jsonResponse({ error: "unsupported_attachment_type" }, 415)
      }
      if (url.endsWith("/api/sfu/session")) {
        return jsonResponse({
          participantId: "participant-1",
          participantToken: "participant-token",
          sessionId: "session-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      }
      return jsonResponse({})
    })
    await expect(
      result.current.uploadRoomAttachment(makeLogFile())
    ).rejects.toThrow("unsupported_attachment_type")
    unmount()
  })
})
