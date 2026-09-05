import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  static instances: FakePeerConnection[] = []
  connectionState = "connected"
  ontrack: ((event: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
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
    FakePeerConnection.instances.length = 0
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

describe("useSfuChatRoom Live Transcript RoomState wiring (#177 PR3)", () => {
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

  beforeEach(() => {
    FakePeerConnection.instances.length = 0
    RecordingWebSocket.instances.length = 0
    ;(global as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection
    ;(global as unknown as { WebSocket: unknown }).WebSocket =
      RecordingWebSocket
    ;(global as unknown as { MediaStream: unknown }).MediaStream = class {
      constructor(_tracks: FakeTrack[] = []) {}
      getAudioTracks() {
        return []
      }
      getTracks() {
        return []
      }
    }
    Object.defineProperty(global.navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [new FakeTrack()],
        }),
      },
      configurable: true,
    })
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/sfu/session"))
        return jsonResponse({
          participantId: "human-a",
          participantToken: "participant-token",
          sessionId: "session-a",
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      if (String(input).endsWith("/api/sfu/datachannels/new"))
        return jsonResponse({ dataChannels: [{ id: 1 }] })
      return jsonResponse({})
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps committed transcript state outside messages and sends only explicit Live Transcript controls", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("transcript-room", "Alice", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: {
            createdAt: 1,
            expiresAt: Date.now() + 60 * 60 * 1000,
            participants: [
              {
                id: "human-a",
                name: "Alice",
                kind: "human",
                connected: true,
                joinedAt: 1,
                lastSeenAt: 1,
              },
              {
                id: "agent-b",
                name: "Codex",
                kind: "agent",
                connected: true,
                joinedAt: 1,
                lastSeenAt: 1,
              },
            ],
            runtimeHosts: {
              "host-a": {
                runtimeHostId: "host-a",
                speech: { stt: true, tts: true },
              },
            },
            runtimeHostProviders: {
              "host-a": { humanParticipantId: "human-a", claimedAt: 1 },
            },
            messages: [],
            liveTranscript: {
              active: true,
              producerRuntimeHostId: "host-a",
              startedByHumanParticipantId: "human-a",
              epoch: 7,
              startedAt: 1,
            },
            liveTranscriptSegments: [
              {
                segmentId: "segment-1",
                epoch: 7,
                sequence: 1,
                participantId: "human-a",
                speaker: "Alice",
                text: "Committed speech",
                createdAt: 1,
              },
            ],
            meetingNotes: { active: false },
            meetingNotesMediaAvailable: true,
            agentVoice: {},
            agentVoiceMediaAvailable: true,
          },
        }),
      })
    )

    await waitFor(() =>
      expect(result.current.liveTranscriptSegments).toHaveLength(1)
    )
    expect(result.current.liveTranscript).toMatchObject({
      active: true,
      epoch: 7,
    })
    expect(result.current.messages).toEqual([])

    act(() => result.current.startLiveTranscript("host-a"))
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      type: "live-transcript-start",
      runtimeHostId: "host-a",
    })
    act(() => result.current.stopLiveTranscript())
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      type: "live-transcript-stop",
    })
    expect(
      socket.sent.map((message) => JSON.parse(message).type)
    ).not.toContain("message")
    // #234: no structured-collab envelope is part of the transcript flow.
    expect(
      socket.sent.map((message) => JSON.parse(message).type)
    ).not.toContain("collab-response")
    unmount()
  })

  it("reuses one pending local Runtime connection claim across repeated clicks", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("claim-room", "Alice", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    const first = result.current.connectLocalRuntime()
    const second = result.current.connectLocalRuntime()
    await waitFor(() => {
      const claimMessages = socket.sent
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === "runtime-provider-claim-create")
      expect(claimMessages).toHaveLength(1)
    })
    const claimMessage = socket.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "runtime-provider-claim-create")
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "runtime-provider-claim-created",
          requestId: claimMessage.requestId,
          expiresAt: Date.now() + 5 * 60 * 1000,
        }),
      })
    )
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(writeText.mock.calls[0][0]).toBe(writeText.mock.calls[1][0])
    expect(writeText.mock.calls[0][0]).toContain(
      "free4chat-agent connect --room"
    )
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
    FakePeerConnection.instances.length = 0
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

  function publishAgentVoice(
    ws: RecordingWebSocket,
    sessionId = "agent-session"
  ) {
    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({
          type: "trackPublished",
          participant: {
            id: "agent-b",
            name: "Agent B",
            kind: "agent",
            sessionId,
            track: { trackName: "agent-voice", kind: "audio" },
          },
        }),
      })
    )
  }

  function resyncAgentVoice(ws: RecordingWebSocket, sessionId?: string) {
    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: {
            createdAt: 0,
            expiresAt: Date.now() + 60 * 60 * 1000,
            participants: sessionId
              ? [
                  {
                    id: "agent-b",
                    name: "Agent B",
                    kind: "agent",
                    connected: true,
                    joinedAt: 0,
                    lastSeenAt: 0,
                    media: {
                      sessionId,
                      muted: false,
                      fileChannelReady: false,
                      tracks: [{ trackName: "agent-voice", kind: "audio" }],
                    },
                  },
                ]
              : [],
            messages: [],
            meetingNotes: { active: false },
            meetingNotesMediaAvailable: true,
            agentVoice: sessionId
              ? { "agent-b": { enabled: true, enabledAt: 1 } }
              : {},
            agentVoiceMediaAvailable: true,
          },
        }),
      })
    )
  }

  function remoteTrackCallCount() {
    return fetchMock.mock.calls.filter(([input, init]) => {
      if (!String(input).endsWith("/api/sfu/tracks")) return false
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
        tracks?: Array<{ location?: string }>
      }
      return body.tracks?.[0]?.location === "remote"
    }).length
  }

  function readyMessages(ws: RecordingWebSocket) {
    return ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.type === "agent-voice-ready")
  }

  function installAgentVoiceTrackResponses(responses: Array<object>) {
    let attempts = 0
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session"))
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "participant-token",
            sessionId: "session-1",
            expiresAt: Date.now() + 60 * 60 * 1000,
          })
        if (url.endsWith("/api/sfu/datachannels/new"))
          return jsonResponse({ dataChannels: [{ id: 1 }] })
        if (url.endsWith("/api/sfu/tracks")) {
          const body = JSON.parse(
            (init?.body as string | undefined) ?? "{}"
          ) as { tracks?: Array<{ location?: string }> }
          if (body.tracks?.[0]?.location === "remote") {
            const response = responses[attempts] ?? responses.at(-1) ?? {}
            attempts += 1
            return jsonResponse(response)
          }
        }
        return jsonResponse({})
      }
    )
    return () => attempts
  }

  const usableAgentVoiceTrackResponse = {
    requiresImmediateRenegotiation: true,
    sessionDescription: { type: "offer", sdp: "fake-sfu-offer" },
    tracks: [{ mid: "7", trackName: "agent-voice" }],
  }

  const noSdpAgentVoiceTrackResponse = {
    requiresImmediateRenegotiation: false,
    tracks: [{ mid: "7", trackName: "agent-voice" }],
  }

  it("includes the authoritative media kind in remote Agent subscriptions", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
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
          requiresImmediateRenegotiation: true,
          sessionDescription: { type: "offer", sdp: "fake-sfu-offer" },
          tracks: [{ mid: "7", trackName: "agent-voice" }],
        })
      return jsonResponse({})
    })

    const { unmount } = await connect("room-remote-kind")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "trackPublished",
          participant: {
            id: "agent-b",
            name: "Agent B",
            kind: "agent",
            sessionId: "agent-session",
            track: { trackName: "agent-voice", kind: "audio" },
          },
        }),
      })
    })

    let trackCall: [RequestInfo | URL, RequestInit] | undefined
    await waitFor(() => {
      trackCall = fetchMock.mock.calls.find(([input, init]) => {
        if (!String(input).endsWith("/api/sfu/tracks")) return false
        const body = JSON.parse(init.body as string) as {
          tracks?: Array<{ location?: string }>
        }
        return body.tracks?.[0]?.location === "remote"
      }) as [RequestInfo | URL, RequestInit] | undefined
      expect(trackCall).toBeDefined()
    })
    const trackBody = JSON.parse(trackCall![1].body as string)
    expect(trackBody.tracks).toEqual([
      {
        location: "remote",
        sessionId: "agent-session",
        trackName: "agent-voice",
        kind: "audio",
      },
    ])
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/sfu/renegotiate")
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(
        ws.sent
          .map((raw) => JSON.parse(raw))
          .some(
            (m) =>
              m.type === "agent-voice-ready" &&
              m.agentParticipantId === "agent-b" &&
              m.sessionId === "agent-session" &&
              m.trackName === "agent-voice"
          )
      ).toBe(true)
    )
    unmount()
  })

  it("re-asserts Agent readiness on resync without repeating a completed subscription", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
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
          requiresImmediateRenegotiation: true,
          sessionDescription: { type: "offer", sdp: "fake-sfu-offer" },
          tracks: [{ mid: "7", trackName: "agent-voice" }],
        })
      return jsonResponse({})
    })

    const { unmount } = await connect("room-readiness-resync")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!
    const trackPublished = {
      type: "trackPublished",
      participant: {
        id: "agent-b",
        name: "Agent B",
        kind: "agent",
        sessionId: "agent-session",
        track: { trackName: "agent-voice", kind: "audio" },
      },
    }
    act(() => ws.onmessage?.({ data: JSON.stringify(trackPublished) }))
    await waitFor(() =>
      expect(
        ws.sent
          .map((raw) => JSON.parse(raw))
          .some((message) => message.type === "agent-voice-ready")
      ).toBe(true)
    )
    const remoteTrackCalls = () =>
      fetchMock.mock.calls.filter(([input, init]) => {
        if (!String(input).endsWith("/api/sfu/tracks")) return false
        const body = JSON.parse(init?.body as string) as {
          tracks?: Array<{ location?: string }>
        }
        return body.tracks?.[0]?.location === "remote"
      }).length
    const initialRemoteTrackCalls = remoteTrackCalls()
    const initialRenegotiateCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/sfu/renegotiate")
    ).length
    ws.sent = []

    // Simulate Room resync after its fail-closed readiness reset. The media
    // subscription remains valid, so the hook must ACK again without a new
    // tracks/new or renegotiation request.
    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: {
            createdAt: 0,
            expiresAt: Date.now() + 60 * 60 * 1000,
            participants: [
              {
                id: "agent-b",
                name: "Agent B",
                kind: "agent",
                connected: true,
                joinedAt: 0,
                lastSeenAt: 0,
                media: {
                  sessionId: "agent-session",
                  muted: false,
                  fileChannelReady: false,
                  tracks: [{ trackName: "agent-voice", kind: "audio" }],
                },
              },
            ],
            messages: [],
            meetingNotes: { active: false },
            meetingNotesMediaAvailable: true,
            agentVoice: { "agent-b": { enabled: true, enabledAt: 1 } },
            agentVoiceMediaAvailable: true,
          },
        }),
      })
    )
    await waitFor(() =>
      expect(
        ws.sent
          .map((raw) => JSON.parse(raw))
          .some(
            (message) =>
              message.type === "agent-voice-ready" &&
              message.agentParticipantId === "agent-b"
          )
      ).toBe(true)
    )
    expect(remoteTrackCalls()).toBe(initialRemoteTrackCalls)
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/sfu/renegotiate")
      ).length
    ).toBe(initialRenegotiateCalls)
    unmount()
  })

  it("does not ACK a deduplicated Agent subscription while negotiation is in flight", async () => {
    let resolveRemoteTracks!: (response: Response) => void
    const pendingRemoteTracks = new Promise<Response>((resolve) => {
      resolveRemoteTracks = resolve
    })
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session"))
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "participant-token",
            sessionId: "session-1",
            expiresAt: Date.now() + 60 * 60 * 1000,
          })
        if (url.endsWith("/api/sfu/datachannels/new"))
          return jsonResponse({ dataChannels: [{ id: 1 }] })
        if (url.endsWith("/api/sfu/tracks")) {
          const body = JSON.parse((init?.body as string | undefined) ?? "{}")
          if (body.tracks?.[0]?.location === "remote")
            return pendingRemoteTracks
        }
        return jsonResponse({})
      }
    )

    const { unmount } = await connect("room-readiness-in-flight")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!
    const participant = {
      id: "agent-b",
      name: "Agent B",
      kind: "agent",
      sessionId: "agent-session",
      track: { trackName: "agent-voice", kind: "audio" },
    }
    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({ type: "trackPublished", participant }),
      })
    )
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (!String(input).endsWith("/api/sfu/tracks")) return false
          const body = JSON.parse((init?.body as string | undefined) ?? "{}")
          return body.tracks?.[0]?.location === "remote"
        })
      ).toBe(true)
    )

    // A resync while the first negotiation is pending is still a dedup, but
    // it is not ACK-safe yet.
    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: {
            createdAt: 0,
            expiresAt: Date.now() + 60 * 60 * 1000,
            participants: [
              {
                id: "agent-b",
                name: "Agent B",
                kind: "agent",
                connected: true,
                joinedAt: 0,
                lastSeenAt: 0,
                media: {
                  sessionId: "agent-session",
                  muted: false,
                  fileChannelReady: false,
                  tracks: [{ trackName: "agent-voice", kind: "audio" }],
                },
              },
            ],
            messages: [],
            meetingNotes: { active: false },
            meetingNotesMediaAvailable: true,
            agentVoice: { "agent-b": { enabled: true, enabledAt: 1 } },
            agentVoiceMediaAvailable: true,
          },
        }),
      })
    )
    expect(
      ws.sent
        .map((raw) => JSON.parse(raw))
        .some((message) => message.type === "agent-voice-ready")
    ).toBe(false)

    resolveRemoteTracks(
      await jsonResponse({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "fake-sfu-offer" },
        tracks: [{ mid: "7", trackName: "agent-voice" }],
      })
    )
    await waitFor(() =>
      expect(
        ws.sent
          .map((raw) => JSON.parse(raw))
          .some((message) => message.type === "agent-voice-ready")
      ).toBe(true)
    )
    unmount()
  })

  it("fails closed and leaves an errored remote subscription retryable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    let trackAttempts = 0
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session"))
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "participant-token",
            sessionId: "session-1",
            expiresAt: Date.now() + 60 * 60 * 1000,
          })
        if (url.endsWith("/api/sfu/datachannels/new"))
          return jsonResponse({ dataChannels: [{ id: 1 }] })
        if (url.endsWith("/api/sfu/tracks")) {
          const body = JSON.parse(
            (init?.body as string | undefined) ?? "{}"
          ) as {
            tracks?: Array<{ location?: string }>
          }
          if (body.tracks?.[0]?.location !== "remote") return jsonResponse({})
          trackAttempts += 1
          if (trackAttempts === 1)
            return Promise.reject(new Error("secret-sdp-fetch-failure"))
          return jsonResponse({
            requiresImmediateRenegotiation: false,
            tracks: [{ errorCode: "track_not_found" }],
          })
        }
        return jsonResponse({})
      }
    )

    const { unmount } = await connect("room-remote-error")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!
    const publish = () =>
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "trackPublished",
            participant: {
              id: "agent-b",
              name: "Agent B",
              kind: "agent",
              sessionId: "agent-session",
              track: { trackName: "agent-voice", kind: "audio" },
            },
          }),
        })
      })

    publish()
    await waitFor(() => expect(trackAttempts).toBe(1))
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/api/sfu/renegotiate")
      )
    ).toBe(false)
    expect(JSON.stringify(warn.mock.calls)).not.toContain("agent-session")

    publish()
    await waitFor(() => expect(trackAttempts).toBe(2))
    const diagnostics = info.mock.calls.flatMap(([message]) => {
      if (
        typeof message !== "string" ||
        !message.startsWith("free4chat_voice_downstream ")
      )
        return []
      return [
        JSON.parse(
          message.slice("free4chat_voice_downstream ".length)
        ) as Record<string, unknown>,
      ]
    })
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "tracks_new_result",
          tracks_new_ok: 0,
          stage: "tracks-new",
          error_type: "Error",
        }),
      ])
    )
    expect(JSON.stringify(diagnostics)).not.toContain(
      "secret-sdp-fetch-failure"
    )
    unmount()
  })

  it("retries a successful no-SDP Agent audio response and ACKs once after negotiation", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const trackAttempts = installAgentVoiceTrackResponses([
      noSdpAgentVoiceTrackResponse,
      usableAgentVoiceTrackResponse,
    ])
    const { unmount } = await connect("room-agent-no-sdp-retry")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!

    publishAgentVoice(ws)
    await waitFor(() => expect(trackAttempts()).toBe(1))
    expect(readyMessages(ws)).toEqual([])

    await waitFor(() => expect(trackAttempts()).toBe(2))
    expect(remoteTrackCallCount()).toBe(2)
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/sfu/renegotiate")
      )
    ).toHaveLength(1)
    expect(readyMessages(ws)).toHaveLength(1)
    expect(readyMessages(ws)[0]).toMatchObject({
      agentParticipantId: "agent-b",
      sessionId: "agent-session",
      trackName: "agent-voice",
    })
    expect(
      info.mock.calls.map(([message]) => String(message)).join("\n")
    ).toContain("agent_audio_subscription_retry_scheduled")
    unmount()
  })

  it("cancels a pending no-SDP retry when the Agent publication disappears", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const trackAttempts = installAgentVoiceTrackResponses([
      noSdpAgentVoiceTrackResponse,
      usableAgentVoiceTrackResponse,
    ])
    const { unmount } = await connect("room-agent-no-sdp-disappear")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!

    publishAgentVoice(ws)
    await waitFor(() => expect(trackAttempts()).toBe(1))

    resyncAgentVoice(ws)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(trackAttempts()).toBe(1)
    expect(readyMessages(ws)).toEqual([])
    expect(
      info.mock.calls.map(([message]) => String(message)).join("\n")
    ).toContain("agent_audio_subscription_retry_cancelled")
    unmount()
  })

  it("cancels P1's pending retry when P2 replaces the Agent audio publication", async () => {
    const trackAttempts = installAgentVoiceTrackResponses([
      noSdpAgentVoiceTrackResponse,
      usableAgentVoiceTrackResponse,
    ])
    const { unmount } = await connect("room-agent-no-sdp-replacement")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!

    publishAgentVoice(ws, "agent-session-p1")
    await waitFor(() => expect(trackAttempts()).toBe(1))

    publishAgentVoice(ws, "agent-session-p2")
    await waitFor(() => expect(trackAttempts()).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(trackAttempts()).toBe(2)
    expect(readyMessages(ws)).toHaveLength(1)
    expect(readyMessages(ws)[0]).toMatchObject({
      sessionId: "agent-session-p2",
    })
    unmount()
  })

  it("keeps one no-SDP retry chain while Room state resyncs", async () => {
    const trackAttempts = installAgentVoiceTrackResponses([
      noSdpAgentVoiceTrackResponse,
      usableAgentVoiceTrackResponse,
    ])
    const { unmount } = await connect("room-agent-no-sdp-dedup")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!

    publishAgentVoice(ws)
    await waitFor(() => expect(trackAttempts()).toBe(1))

    resyncAgentVoice(ws, "agent-session")
    expect(trackAttempts()).toBe(1)
    await waitFor(() => expect(trackAttempts()).toBe(2))

    expect(trackAttempts()).toBe(2)
    expect(readyMessages(ws)).toHaveLength(1)
    unmount()
  })

  it("leaves exhausted Agent audio retry state recoverable by a later resync", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const trackAttempts = installAgentVoiceTrackResponses([
      noSdpAgentVoiceTrackResponse,
      noSdpAgentVoiceTrackResponse,
      noSdpAgentVoiceTrackResponse,
      usableAgentVoiceTrackResponse,
    ])
    const { unmount } = await connect("room-agent-no-sdp-exhausted")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!

    publishAgentVoice(ws)
    await waitFor(() => expect(trackAttempts()).toBe(3))

    expect(trackAttempts()).toBe(3)
    expect(readyMessages(ws)).toEqual([])
    expect(
      info.mock.calls.map(([message]) => String(message)).join("\n")
    ).toContain("agent_audio_subscription_retry_exhausted")

    resyncAgentVoice(ws, "agent-session")
    await waitFor(() => expect(trackAttempts()).toBe(4))
    expect(readyMessages(ws)).toHaveLength(1)
    unmount()
  })

  it("drops an in-flight retry from a stale Human media session before ACKing", async () => {
    let sessionAttempts = 0
    let remoteTrackAttempts = 0
    const remoteSubscriberSessionIds: string[] = []
    let resolveRetryTracks!: (response: Response) => void
    const pendingRetryTracks = new Promise<Response>((resolve) => {
      resolveRetryTracks = resolve
    })
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session")) {
          sessionAttempts += 1
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "participant-token",
            sessionId: `human-session-${sessionAttempts}`,
            expiresAt: Date.now() + 60 * 60 * 1000,
          })
        }
        if (url.endsWith("/api/sfu/datachannels/new"))
          return jsonResponse({ dataChannels: [{ id: 1 }] })
        if (url.endsWith("/api/sfu/tracks")) {
          const body = JSON.parse(
            (init?.body as string | undefined) ?? "{}"
          ) as {
            sessionId?: string
            tracks?: Array<{ location?: string }>
          }
          if (body.tracks?.[0]?.location !== "remote") return jsonResponse({})
          remoteTrackAttempts += 1
          remoteSubscriberSessionIds.push(body.sessionId ?? "")
          if (remoteTrackAttempts === 1)
            return jsonResponse(noSdpAgentVoiceTrackResponse)
          if (remoteTrackAttempts === 2) return pendingRetryTracks
          return jsonResponse(usableAgentVoiceTrackResponse)
        }
        return jsonResponse({})
      }
    )

    const { unmount } = await connect("room-agent-no-sdp-stale-media")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const oldPc = FakePeerConnection.instances.at(-1)!
    const oldSetRemoteDescription = vi.spyOn(oldPc, "setRemoteDescription")
    const oldWs = RecordingWebSocket.instances.at(-1)!

    publishAgentVoice(oldWs)
    await waitFor(() => expect(remoteTrackAttempts).toBe(2))

    oldPc.connectionState = "disconnected"
    act(() => oldPc.onconnectionstatechange?.())
    await waitFor(() => expect(sessionAttempts).toBe(2))

    // The reconnect's local publication is queued behind the old retry, so
    // resolve the latter only after the new Human session has replaced it.
    resolveRetryTracks(await jsonResponse(usableAgentVoiceTrackResponse))
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(1)
    )
    const newWs = RecordingWebSocket.instances.at(-1)!

    expect(oldSetRemoteDescription).not.toHaveBeenCalled()
    expect(readyMessages(newWs)).toEqual([])

    resyncAgentVoice(newWs, "agent-session")
    await waitFor(() => expect(remoteTrackAttempts).toBe(3))
    await waitFor(() => expect(readyMessages(newWs)).toHaveLength(1))

    expect(remoteSubscriberSessionIds).toEqual([
      "human-session-1",
      "human-session-1",
      "human-session-2",
    ])
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/sfu/renegotiate")
      )
    ).toHaveLength(1)
    unmount()
  })

  it("observes the complete Agent audio downstream path without exposing secrets", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
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
          sessionDescription: { type: "offer", sdp: "secret-sdp" },
          tracks: [{ mid: "7", trackName: "secret-track" }],
        })
      return jsonResponse({})
    })

    const { unmount } = await connect("room-remote-observability")
    await waitFor(() =>
      expect(RecordingWebSocket.instances.length).toBeGreaterThan(0)
    )
    const ws = RecordingWebSocket.instances.at(-1)!
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: {
            createdAt: 0,
            expiresAt: Date.now() + 60 * 60 * 1000,
            participants: [
              {
                id: "agent-b",
                name: "Agent B",
                kind: "agent",
                connected: true,
                joinedAt: 0,
                lastSeenAt: 0,
                media: {
                  sessionId: "agent-session",
                  muted: false,
                  fileChannelReady: false,
                  tracks: [{ trackName: "agent-voice", kind: "audio" }],
                },
              },
            ],
            messages: [],
            meetingNotes: { active: false },
            meetingNotesMediaAvailable: true,
            agentVoice: { "agent-b": { enabled: true, enabledAt: 1 } },
            agentVoiceMediaAvailable: true,
          },
        }),
      })
    })

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/sfu/renegotiate")
        )
      ).toBe(true)
    )
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "trackPublished",
          participant: {
            id: "agent-b",
            name: "Agent B",
            kind: "agent",
            sessionId: "agent-session",
            track: { trackName: "agent-voice", kind: "audio" },
          },
        }),
      })
    })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).endsWith("/api/sfu/renegotiate")
        )
      ).toHaveLength(2)
    )
    const pc = FakePeerConnection.instances.at(-1)!
    const track = new FakeTrack()
    act(() => {
      pc.ontrack?.({
        track,
        streams: [],
        transceiver: { mid: "7" },
      })
    })

    const diagnostics = info.mock.calls.flatMap(([message]) => {
      if (
        typeof message !== "string" ||
        !message.startsWith("free4chat_voice_downstream ")
      )
        return []
      return [
        JSON.parse(
          message.slice("free4chat_voice_downstream ".length)
        ) as Record<string, unknown>,
      ]
    })
    const sfuDiagnostics = info.mock.calls.flatMap(([message]) => {
      if (
        typeof message !== "string" ||
        !message.startsWith("free4chat_sfu_downstream ")
      )
        return []
      return [
        JSON.parse(message.slice("free4chat_sfu_downstream ".length)) as Record<
          string,
          unknown
        >,
      ]
    })
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "room_state_observed",
          agent_audio_track_visible_in_state: 1,
          agent_audio_track_count: 1,
        }),
        expect.objectContaining({
          event: "track_published_received",
          participant_kind: "agent",
          track_kind: "audio",
          participant_found: 1,
          publisher_session_present: 1,
        }),
        expect.objectContaining({
          event: "subscribe_track_entered",
          participant_kind: "agent",
          track_kind: "audio",
          media_present: 1,
        }),
        expect.objectContaining({
          event: "tracks_new_result",
          tracks_new_ok: 1,
          has_session_description: 1,
          session_description_type: "offer",
          track_result_count: 1,
          track_has_mid: 1,
        }),
        expect.objectContaining({ event: "remote_description_applied" }),
        expect.objectContaining({ event: "answer_created" }),
        expect.objectContaining({ event: "local_description_applied" }),
        expect.objectContaining({ event: "renegotiate_ok" }),
        expect.objectContaining({
          event: "ontrack_fired",
          received_track_kind: "audio",
          remote_track_binding_present: 1,
        }),
        expect.objectContaining({
          event: "stream_attached",
          stream_attached: 1,
          attached_kind: "audio",
        }),
      ])
    )
    expect(sfuDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "remote_track_attached",
          participant_kind: "agent",
          track_kind: "audio",
        }),
      ])
    )
    expect(JSON.stringify(diagnostics)).not.toContain("secret-sdp")
    expect(JSON.stringify(diagnostics)).not.toContain("secret-track")
    expect(JSON.stringify(diagnostics)).not.toContain("agent-session")
    unmount()
  })
})
