import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useSfuChatRoom } from "./useSfuChatRoom"
import { participantDirectReliableChannelName } from "../common/participantDataChannel"
import {
  EMPTY_ROOM_APP_CATALOG,
  roomAppInstanceId,
  setProductionRoomAppCatalog,
} from "../common/roomApp"

const TEST_ROOM_APP = {
  id: "test-app",
  label: "Test App",
  url: "https://room-apps.free4.chat/test-app",
  origin: "https://room-apps.free4.chat",
}

class FakeTrack {
  kind: "audio" | "video" = "audio"
  enabled = true
  readyState = "live"
  stop = vi.fn()
}

class FakeDataChannel {
  constructor(
    public label = "",
    public options: Record<string, unknown> = {}
  ) {}
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
  emit(type: string, event: unknown) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  static dataChannels: FakeDataChannel[] = []
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
  createDataChannel(label: string, options: Record<string, unknown> = {}) {
    const channel = new FakeDataChannel(label, options)
    FakePeerConnection.dataChannels.push(channel)
    return channel
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

function localTrackResponse(init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    tracks?: Array<{ location?: string; mid?: string; trackName?: string }>
  }
  const track = body.tracks?.find((entry) => entry.location === "local")
  if (!track) return null
  return jsonResponse({
    sessionDescription: { type: "answer", sdp: "fake-local-answer" },
    tracks: [{ mid: track.mid ?? "0", trackName: track.trackName }],
  })
}

let lastFakeWebSocket: {
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  send: ReturnType<typeof vi.fn>
} | null = null

describe("useSfuChatRoom — Turnstile boundary", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let getUserMedia: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setProductionRoomAppCatalog([TEST_ROOM_APP])
    FakePeerConnection.instances.length = 0
    FakePeerConnection.dataChannels.length = 0
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
      send = vi.fn()
      constructor(public url: string) {
        lastFakeWebSocket = this
      }
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

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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
        return localTrackResponse(init) ?? jsonResponse({})
      }
      return jsonResponse({})
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    lastFakeWebSocket = null
    setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("requests a fresh Turnstile token before creating a new Human session, and sends it to /api/sfu/session", async () => {
    const getTurnstileToken = vi.fn().mockResolvedValue("fresh-token")

    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("room-a", "alice", "audio", { getTurnstileToken })
    )

    await waitFor(() => expect(getTurnstileToken).toHaveBeenCalledTimes(1))

    // #402: joining never captures audio; verification therefore precedes any
    // microphone request, and the first request only happens on explicit
    // Human action.
    expect(getUserMedia).not.toHaveBeenCalled()
    const tokenCallOrder = getTurnstileToken.mock.invocationCallOrder[0]
    act(() => {
      result.current.toggleMicrophone()
    })
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

  it("dispatches reliable and realtime Room App messages on the shared transport", async () => {
    const appInstanceId = roomAppInstanceId("room-app", "test-app")
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session"))
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "participant-token",
            sessionId: "session-1",
            expiresAt: Date.now() + 60 * 60 * 1000,
            roomAppsEnabled: true,
          })
        if (url.endsWith("/api/sfu/datachannels/establish"))
          return jsonResponse({})
        if (url.endsWith("/api/sfu/datachannels/new")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            dataChannels?: Array<{ dataChannelName?: string }>
          }
          const appChannels = body.dataChannels?.filter((channel) =>
            channel.dataChannelName?.startsWith("room-app-")
          )
          if (appChannels?.length)
            return jsonResponse({
              dataChannels: appChannels.map((_, index) => ({ id: index + 2 })),
            })
          return jsonResponse({ dataChannels: [{ id: 1 }] })
        }
        if (url.endsWith("/api/sfu/tracks"))
          return localTrackResponse(init) ?? jsonResponse({})
        return jsonResponse({})
      }
    )

    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("room-app", "alice", "audio", {})
    )

    const privateMessages: unknown[] = []
    const privateResults: unknown[] = []
    const agentRequests: unknown[] = []

    await waitFor(() => expect(result.current.roomAppsEnabled).toBe(true))
    await waitFor(() => expect(lastFakeWebSocket).not.toBeNull())
    act(() => {
      lastFakeWebSocket?.onopen?.()
      result.current.subscribeRoomAppUnicast((message) =>
        privateMessages.push(message)
      )
      result.current.subscribeRoomAppUnicastResults((response) =>
        privateResults.push(response)
      )
      result.current.subscribeRoomAppAgentRequests((request) =>
        agentRequests.push(request)
      )
    })
    await waitFor(() =>
      expect(
        FakePeerConnection.dataChannels.filter((channel) =>
          channel.label.startsWith("room-app-")
        )
      ).toHaveLength(2)
    )

    act(() => {
      expect(
        result.current.sendRoomAppMessage("reliable", appInstanceId, {
          type: "update",
        })
      ).toBe(true)
      expect(
        result.current.sendRoomAppMessage("realtime", appInstanceId, {
          type: "cursor",
        })
      ).toBe(true)
      expect(
        result.current.sendRoomAppUnicast(
          "request_1",
          "participant-2",
          appInstanceId,
          { type: "secret_word", word: "otter" }
        )
      ).toBe("sent")
    })

    expect(JSON.parse(lastFakeWebSocket!.send.mock.calls.at(-1)![0])).toEqual({
      type: "room-app-unicast",
      requestId: "request_1",
      targetParticipantId: "participant-2",
      appInstanceId,
      payload: { type: "secret_word", word: "otter" },
    })
    act(() => {
      lastFakeWebSocket?.onmessage?.({
        data: JSON.stringify({
          type: "room-app-unicast",
          protocolVersion: 1,
          appInstanceId,
          sourceParticipantId: "participant-2",
          payload: { type: "secret_word", word: "otter" },
        }),
      })
      lastFakeWebSocket?.onmessage?.({
        data: JSON.stringify({
          type: "room-app-unicast-result",
          requestId: "request_1",
          appInstanceId,
          ok: true,
        }),
      })
      lastFakeWebSocket?.onmessage?.({
        data: JSON.stringify({
          type: "room-app-agent-request",
          requestId: "agent_request_1",
          appInstanceId,
          payload: { opaque: [1, "two"] },
        }),
      })
    })
    expect(privateMessages).toEqual([
      {
        protocolVersion: 1,
        appInstanceId,
        sourceParticipantId: "participant-2",
        payload: { type: "secret_word", word: "otter" },
      },
    ])
    expect(privateResults).toEqual([
      { requestId: "request_1", appInstanceId, ok: true },
    ])
    expect(agentRequests).toEqual([
      {
        requestId: "agent_request_1",
        appInstanceId,
        payload: { opaque: [1, "two"] },
      },
    ])

    const channels = FakePeerConnection.dataChannels.filter((channel) =>
      channel.label.startsWith("room-app-")
    )
    expect(
      JSON.parse(String(channels[0]!.send.mock.calls[0]![0]))
    ).toMatchObject({ lane: "reliable", appInstanceId })
    expect(
      JSON.parse(String(channels[1]!.send.mock.calls[0]![0]))
    ).toMatchObject({ lane: "realtime", appInstanceId })
    unmount()
  })

  it("correlates host eligibility sends and broker receipt across Room socket epochs", async () => {
    const appInstanceId = roomAppInstanceId("room-app", "test-app")
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session"))
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "SECRET_TOKEN",
            sessionId: "SECRET_SESSION",
            expiresAt: Date.now() + 3600000,
            roomAppsEnabled: true,
          })
        if (url.endsWith("/api/sfu/datachannels/establish"))
          return jsonResponse({})
        if (url.endsWith("/api/sfu/datachannels/new"))
          return jsonResponse({ dataChannels: [{ id: 1 }] })
        if (url.endsWith("/api/sfu/tracks"))
          return localTrackResponse(init) ?? jsonResponse({})
        return jsonResponse({})
      }
    )
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("room-app", "alice", "audio", {})
    )
    await waitFor(() => expect(lastFakeWebSocket).not.toBeNull())
    const firstSocket = lastFakeWebSocket!
    const trace = window.__free4chatRoomAppTransportDiagnostics!
    trace.enable()
    act(() => {
      firstSocket.onopen?.()
      result.current.setRoomAppHostReady(appInstanceId, true)
    })
    expect(
      trace
        .read()
        .find(
          ({ event, ready }) => event === "room_app_host_state_sent" && ready
        )
    ).toMatchObject({
      appInstanceId,
      participantId: "participant-1",
      roomSocketEpoch: 1,
    })

    vi.useFakeTimers()
    act(() => firstSocket.onclose?.())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    vi.useRealTimers()
    const secondSocket = lastFakeWebSocket!
    expect(secondSocket).not.toBe(firstSocket)
    act(() => secondSocket.onopen?.())
    expect(
      trace
        .read()
        .filter(({ event }) => event === "room_socket_created")
        .map(({ roomSocketEpoch }) => roomSocketEpoch)
    ).toEqual([2]) // The trace was enabled after socket 1 was created.
    expect(trace.current().roomSocketEpoch).toBe(2)
    expect(
      trace
        .read()
        .filter(
          ({ event, ready }) => event === "room_app_host_state_sent" && ready
        )
        .at(-1)
    ).toMatchObject({
      appInstanceId,
      roomSocketEpoch: 2,
    })
    let loggedBeforeForward = false
    const unsubscribe = result.current.subscribeRoomAppAgentRequests(() => {
      loggedBeforeForward = trace
        .read()
        .some(({ event }) => event === "broker_agent_request_received")
    })
    act(() =>
      secondSocket.onmessage?.({
        data: JSON.stringify({
          type: "room-app-agent-request",
          appInstanceId,
          requestId: "PRIVATE_REQUEST_ID",
          payload: { text: "PRIVATE_BOARD_TEXT" },
        }),
      })
    )
    expect(
      trace
        .read()
        .find(({ event }) => event === "broker_agent_request_received")
    ).toMatchObject({
      appInstanceId,
      participantId: "participant-1",
      roomSocketEpoch: 2,
      requestTag: expect.any(String),
    })
    expect(loggedBeforeForward).toBe(true)
    expect(
      trace
        .read()
        .find(({ event }) => event === "broker_agent_request_received")
        ?.requestTag
    ).toMatch(/^[0-9a-f]{8}$/)
    act(() => result.current.setRoomAppHostReady(appInstanceId, false))
    expect(
      trace
        .read()
        .filter(({ event }) => event === "room_app_host_state_sent")
        .at(-1)
    ).toMatchObject({
      appInstanceId,
      ready: false,
      roomSocketEpoch: 2,
    })
    const serialized = JSON.stringify(trace.read())
    for (const secret of [
      "SECRET_TOKEN",
      "SECRET_SESSION",
      "PRIVATE_REQUEST_ID",
      "PRIVATE_BOARD_TEXT",
    ])
      expect(serialized).not.toContain(secret)
    trace.disable()
    unsubscribe()
    unmount()
  })

  it("isolates optional Room App channel setup failures from the Room connection", async () => {
    let dataChannelNewCalls = 0
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session"))
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "participant-token",
            sessionId: "session-1",
            expiresAt: Date.now() + 60 * 60 * 1000,
            roomAppsEnabled: true,
          })
        if (url.endsWith("/api/sfu/datachannels/establish"))
          return jsonResponse({})
        if (url.endsWith("/api/sfu/datachannels/new")) {
          dataChannelNewCalls += 1
          if (dataChannelNewCalls === 2)
            return Promise.reject(new Error("room_app_channels_unavailable"))
          return jsonResponse({ dataChannels: [{ id: 1 }] })
        }
        if (url.endsWith("/api/sfu/tracks"))
          return localTrackResponse(init) ?? jsonResponse({})
        return jsonResponse({})
      }
    )

    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("room-app-failure", "alice", "audio", {})
    )

    await waitFor(() => expect(dataChannelNewCalls).toBe(2))
    expect(result.current.roomAppsEnabled).toBe(false)
    expect(result.current.error).toBe("")
    expect(
      FakePeerConnection.dataChannels.some((channel) =>
        channel.label.startsWith("files-")
      )
    ).toBe(true)
    await waitFor(() => expect(lastFakeWebSocket).not.toBeNull())
    act(() =>
      lastFakeWebSocket?.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: {
            participants: [],
            messages: [],
            attachments: [],
            liveTranscript: { active: false },
            liveTranscriptSegments: [],
            agentVoice: {},
            agentVoiceMediaAvailable: false,
            meetingNotesMediaAvailable: false,
            runtimeHosts: {},
            roomAppsEnabled: true,
          },
        }),
      })
    )
    expect(result.current.roomAppsEnabled).toBe(false)
    expect(result.current.error).toBe("")
    unmount()
  })

  it("subscribes the private Agent-Human reliable lane and carries capability requests and results there", async () => {
    const appInstanceId = "generated:123e4567-e89b-12d3-a456-426614174000"
    const dataChannelCalls: Array<Record<string, unknown>> = []
    let failDirectSubscriptions = false
    let subscriberSessionNumber = 0
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session"))
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "participant-token",
            sessionId: `session-${++subscriberSessionNumber}`,
            expiresAt: Date.now() + 60 * 60 * 1000,
            roomAppsEnabled: true,
          })
        if (url.endsWith("/api/sfu/datachannels/establish"))
          return jsonResponse({})
        if (url.endsWith("/api/sfu/datachannels/new")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >
          dataChannelCalls.push(body)
          if (
            failDirectSubscriptions &&
            body.transport === "participant-direct-reliable"
          )
            return jsonResponse({ dataChannels: [] })
          const channels = Array.isArray(body.dataChannels)
            ? body.dataChannels
            : []
          return jsonResponse({
            dataChannels: channels.map((_, index) => ({ id: 20 + index })),
          })
        }
        if (url.endsWith("/api/sfu/tracks"))
          return localTrackResponse(init) ?? jsonResponse({})
        return jsonResponse({})
      }
    )

    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("agent-data-lane", "alice", "audio", {})
    )
    await waitFor(() => expect(lastFakeWebSocket).not.toBeNull())
    act(() => lastFakeWebSocket?.onopen?.())
    const diagnostics = window.__free4chatRoomAppTransportDiagnostics!
    diagnostics.enable()
    const sendAgentState = (
      ready: boolean,
      publisherSessionId = "agent-data-session",
      includeAgent = true
    ) =>
      act(() =>
        lastFakeWebSocket?.onmessage?.({
          data: JSON.stringify({
            type: "state",
            state: {
              createdAt: 1,
              expiresAt: Date.now() + 60 * 60 * 1000,
              participants: [
                {
                  id: "participant-1",
                  name: "Alice",
                  kind: "human",
                  connected: true,
                  joinedAt: 1,
                  lastSeenAt: 1,
                  media: {
                    sessionId: "session-1",
                    muted: false,
                    fileChannelReady: false,
                    appDataChannelReady: true,
                    tracks: [],
                  },
                },
                ...(includeAgent
                  ? [
                      {
                        id: "agent-a",
                        name: "Agent",
                        kind: "agent",
                        connected: true,
                        joinedAt: 1,
                        lastSeenAt: 1,
                        participantDataTransport: {
                          sessionId: publisherSessionId,
                          ready,
                        },
                      },
                    ]
                  : []),
              ],
              messages: [],
              attachments: [],
              generatedApps: {
                [appInstanceId]: {
                  appInstanceId,
                  taskRequestId: "task-a",
                  title: "Status",
                  bundleBytes: 100,
                  bundleRevision: 3,
                  stateRevision: 0,
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
              liveTranscript: { active: false },
              liveTranscriptSegments: [],
              meetingNotes: { active: false },
              meetingNotesMediaAvailable: false,
              agentVoice: {},
              agentVoiceMediaAvailable: false,
              roomAppsEnabled: true,
            },
          }),
        })
      )
    sendAgentState(false)
    await expect(
      result.current.requestGeneratedAppCapability({
        appInstanceId,
        bundleRevision: 3,
        taskRequestId: "task-a",
        agentParticipantId: "agent-a",
        requestId: "request-not-ready",
        capabilityId: "printer_status",
        operation: "observe",
      })
    ).resolves.toMatchObject({ ok: false, error: "unavailable" })
    expect(
      diagnostics
        .read()
        .filter(
          ({ transition, reason }) =>
            transition === "rejected" && reason === "agent_transport_not_ready"
        )
    ).toHaveLength(1)
    expect(
      dataChannelCalls.some(
        (call) => call.publisherSessionId === "agent-data-session"
      )
    ).toBe(false)
    sendAgentState(true)
    await expect(
      result.current.requestGeneratedAppCapability({
        appInstanceId,
        bundleRevision: 3,
        taskRequestId: "task-a",
        agentParticipantId: "agent-a",
        requestId: "request-no-direct-lane",
        capabilityId: "printer_status",
        operation: "observe",
      })
    ).resolves.toMatchObject({ ok: false, error: "unavailable" })
    expect(
      diagnostics
        .read()
        .some(
          ({ transition, reason }) =>
            transition === "rejected" && reason === "direct_lane_absent"
        )
    ).toBe(true)

    const directChannelName = participantDirectReliableChannelName(
      "agent-a",
      "participant-1"
    )
    await waitFor(() =>
      expect(
        dataChannelCalls.some(
          (call) =>
            call.transport === "participant-direct-reliable" &&
            Array.isArray(call.dataChannels) &&
            (call.dataChannels[0] as { dataChannelName?: string })
              .dataChannelName === directChannelName
        )
      ).toBe(true)
    )
    const directSubscription = dataChannelCalls.find(
      (call) => call.transport === "participant-direct-reliable"
    )
    expect(directSubscription?.dataChannels).toEqual([
      expect.objectContaining({
        location: "remote",
        peerParticipantId: "agent-a",
        dataChannelName: directChannelName,
        ordered: true,
        waitForAck: true,
        canReply: true,
      }),
    ])
    const agentSubscriber = FakePeerConnection.dataChannels.find(
      (channel) => channel.label === `${directChannelName}-subscriber`
    )
    expect(agentSubscriber).toBeDefined()

    let capabilityResult!: ReturnType<
      typeof result.current.requestGeneratedAppCapability
    >
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout")
    act(() => {
      capabilityResult = result.current.requestGeneratedAppCapability({
        appInstanceId,
        bundleRevision: 3,
        taskRequestId: "task-a",
        agentParticipantId: "agent-a",
        requestId: "request-1",
        capabilityId: "printer_status",
        operation: "observe",
      })
    })
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 12_000)).toBe(
      true
    )
    timeoutSpy.mockRestore()
    const localReliable = FakePeerConnection.dataChannels.find(
      (channel) => channel.label === "room-app-reliable-participant-1"
    )
    await waitFor(() =>
      expect(agentSubscriber?.send.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
    expect(localReliable?.send).not.toHaveBeenCalled()
    const outbound = agentSubscriber?.send.mock.calls
      .filter(([wire]) => wire !== "ack")
      .map(([wire]) => JSON.parse(String(wire)))
      .find((message) => message.payload?.type === "runtime-capability-request")
    expect(outbound).toBeDefined()
    expect(outbound.payload.type).toBe("runtime-capability-request")
    expect(
      lastFakeWebSocket?.send.mock.calls.some(([wire]) =>
        String(wire).includes("runtime-capability-request")
      )
    ).toBe(false)
    expect(
      diagnostics.read().some(({ transition }) => transition === "sent")
    ).toBe(true)
    expect(
      diagnostics
        .read()
        .some(
          ({ transition, lane }) =>
            transition === "ready" && lane === "participant_direct_reliable"
        )
    ).toBe(true)

    act(() =>
      agentSubscriber?.emit("message", {
        data: JSON.stringify({
          protocolVersion: 1,
          appInstanceId,
          lane: "reliable",
          payload: {
            type: "runtime-capability-result",
            requestId: "request-1",
            appInstanceId,
            bundleRevision: 3,
            taskRequestId: "task-a",
            agentParticipantId: "agent-a",
            capabilityId: "printer_status",
            operation: "observe",
            ok: true,
            result: { state: "ready", acceptingJobs: true },
          },
        }),
      })
    )
    await expect(capabilityResult!).resolves.toMatchObject({
      ok: true,
      result: { state: "ready", acceptingJobs: true },
    })

    // An isolated close/error on the ready direct channel must recover without
    // any Room WebSocket state refresh or PeerConnection replacement.
    vi.useFakeTimers()
    const initialDirectCalls = dataChannelCalls.filter(
      (call) => call.transport === "participant-direct-reliable"
    ).length
    const roomSocketSendCountBeforeRecovery =
      lastFakeWebSocket?.send.mock.calls.length ?? 0
    act(() => {
      agentSubscriber?.emit("close", {})
      agentSubscriber?.emit("error", {})
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    const directCallsAfterRecovery = dataChannelCalls.filter(
      (call) => call.transport === "participant-direct-reliable"
    ).length
    expect(directCallsAfterRecovery).toBe(initialDirectCalls + 1)
    expect(
      diagnostics
        .read()
        .some(
          ({ transition, lane }) =>
            transition === "closed" && lane === "participant_direct_reliable"
        )
    ).toBe(true)
    expect(
      diagnostics
        .read()
        .some(
          ({ transition, lane }) =>
            transition === "recovery_scheduled" &&
            lane === "participant_direct_reliable"
        )
    ).toBe(true)
    const replacementDirectChannel = FakePeerConnection.dataChannels.find(
      (channel) =>
        channel.label === `${directChannelName}-subscriber` &&
        channel !== agentSubscriber
    )
    expect(replacementDirectChannel).toBeDefined()
    expect(FakePeerConnection.instances).toHaveLength(1)
    expect(lastFakeWebSocket?.send.mock.calls).toHaveLength(
      roomSocketSendCountBeforeRecovery
    )

    let recoveredCapabilityResult!: ReturnType<
      typeof result.current.requestGeneratedAppCapability
    >
    act(() => {
      recoveredCapabilityResult = result.current.requestGeneratedAppCapability({
        appInstanceId,
        bundleRevision: 3,
        taskRequestId: "task-a",
        agentParticipantId: "agent-a",
        requestId: "request-2",
        capabilityId: "printer_status",
        operation: "observe",
      })
    })
    expect(replacementDirectChannel?.send).toHaveBeenCalled()
    act(() =>
      replacementDirectChannel?.emit("message", {
        data: JSON.stringify({
          protocolVersion: 1,
          appInstanceId,
          lane: "reliable",
          payload: {
            type: "runtime-capability-result",
            requestId: "request-2",
            appInstanceId,
            bundleRevision: 3,
            taskRequestId: "task-a",
            agentParticipantId: "agent-a",
            capabilityId: "printer_status",
            operation: "observe",
            ok: true,
            result: { state: "ready", acceptingJobs: true },
          },
        }),
      })
    )
    await expect(recoveredCapabilityResult!).resolves.toMatchObject({
      ok: true,
      result: { state: "ready", acceptingJobs: true },
    })
    // Late duplicate events from the removed channel cannot start another
    // chain, and a healthy replacement performs no periodic resubscription.
    act(() => {
      agentSubscriber?.emit("close", {})
      agentSubscriber?.emit("error", {})
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(
      dataChannelCalls.filter(
        (call) => call.transport === "participant-direct-reliable"
      )
    ).toHaveLength(initialDirectCalls + 1)

    // Establishment failures after a close use the same bounded schedule and
    // stop after the configured three retry attempts.
    failDirectSubscriptions = true
    act(() => replacementDirectChannel?.emit("close", {}))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600)
    })
    const directCallsAfterExhaustion = dataChannelCalls.filter(
      (call) => call.transport === "participant-direct-reliable"
    ).length
    expect(directCallsAfterExhaustion).toBe(initialDirectCalls + 4)
    expect(
      diagnostics
        .read()
        .some(
          ({ transition, reason }) =>
            transition === "recovery_exhausted" &&
            reason === "direct_lane_retry_exhausted"
        )
    ).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(
      dataChannelCalls.filter(
        (call) => call.transport === "participant-direct-reliable"
      )
    ).toHaveLength(directCallsAfterExhaustion)
    failDirectSubscriptions = false

    // Restore a Ready channel, then rotate the publisher projection so the
    // dropped old-generation lane transition is observable.
    sendAgentState(true)
    for (let index = 0; index < 40; index += 1) await Promise.resolve()
    const readyForRotation = FakePeerConnection.dataChannels
      .filter((channel) => channel.label === `${directChannelName}-subscriber`)
      .at(-1)
    expect(readyForRotation?.readyState).toBe("open")
    const directCallsBeforeRotation = dataChannelCalls.filter(
      (call) => call.transport === "participant-direct-reliable"
    ).length

    // A publisher session rotation owns its own subscription and cancels the
    // delayed retry captured from the old Agent transport generation.
    act(() => readyForRotation?.emit("close", {}))
    sendAgentState(true, "agent-data-session-rotated")
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    const directCallsAfterRotation = dataChannelCalls.filter(
      (call) => call.transport === "participant-direct-reliable"
    ).length
    expect(directCallsAfterRotation).toBe(directCallsBeforeRotation + 1)
    expect(
      diagnostics
        .read()
        .some(
          ({ transition, reason }) =>
            transition === "stale_transition_dropped" &&
            reason === "stale_publisher_generation"
        )
    ).toBe(true)

    // Leaving removes the participant and invalidates a scheduled recovery.
    const rotatedChannel = FakePeerConnection.dataChannels
      .filter((channel) => channel.label === `${directChannelName}-subscriber`)
      .at(-1)
    act(() => rotatedChannel?.emit("close", {}))
    sendAgentState(false, "agent-data-session-rotated", false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(
      dataChannelCalls.filter(
        (call) => call.transport === "participant-direct-reliable"
      )
    ).toHaveLength(directCallsAfterRotation)

    // A PeerConnection and Human subscriber session replacement takes
    // ownership of recovery and invalidates the old channel retry.
    sendAgentState(true, "agent-data-session-rotated")
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    const rejoinedChannel = FakePeerConnection.dataChannels
      .filter((channel) => channel.label === `${directChannelName}-subscriber`)
      .at(-1)
    act(() => rejoinedChannel?.emit("close", {}))
    const oldPeerConnection = FakePeerConnection.instances[0]
    const oldRoomSocket = lastFakeWebSocket
    act(() => {
      oldPeerConnection.connectionState = "failed"
      oldPeerConnection.onconnectionstatechange?.()
    })
    for (let index = 0; index < 40; index += 1) await Promise.resolve()
    expect(FakePeerConnection.instances).toHaveLength(2)
    expect(subscriberSessionNumber).toBe(2)
    expect(
      diagnostics
        .read()
        .some(
          ({ transition, reason }) =>
            transition === "stale_transition_dropped" &&
            reason === "stale_subscriber_generation"
        )
    ).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    const callsAfterPeerReplacement = dataChannelCalls.filter(
      (call) => call.transport === "participant-direct-reliable"
    ).length
    expect(callsAfterPeerReplacement).toBe(directCallsAfterRotation + 1)

    // A pending timer is also disposed by unmount.
    for (
      let index = 0;
      index < 40 && lastFakeWebSocket === oldRoomSocket;
      index += 1
    )
      await Promise.resolve()
    expect(lastFakeWebSocket).not.toBe(oldRoomSocket)
    act(() => lastFakeWebSocket?.onopen?.())
    sendAgentState(true, "agent-data-session-rotated")
    for (let index = 0; index < 40; index += 1) await Promise.resolve()
    const newSessionChannel = FakePeerConnection.dataChannels
      .filter((channel) => channel.label === `${directChannelName}-subscriber`)
      .at(-1)
    expect(newSessionChannel).toBeDefined()
    act(() => newSessionChannel?.emit("close", {}))
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(
      dataChannelCalls.filter(
        (call) => call.transport === "participant-direct-reliable"
      )
    ).toHaveLength(callsAfterPeerReplacement + 1)
  })

  it("subscribes to remote Room App lanes, tags the bound sender, retries, and cleans up", async () => {
    const appInstanceId = roomAppInstanceId("remote-app-room", "test-app")
    let dataChannelNewCalls = 0
    let remoteFailureCount = 0
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/api/sfu/session"))
          return jsonResponse({
            participantId: "participant-1",
            participantToken: "participant-token",
            sessionId: "session-1",
            expiresAt: Date.now() + 60 * 60 * 1000,
            roomAppsEnabled: true,
          })
        if (url.endsWith("/api/sfu/datachannels/establish"))
          return jsonResponse({})
        if (url.endsWith("/api/sfu/datachannels/new")) {
          dataChannelNewCalls += 1
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            publisherSessionId?: string
            dataChannels?: Array<{ dataChannelName?: string }>
          }
          if (body.publisherSessionId && remoteFailureCount === 0) {
            remoteFailureCount += 1
            return Promise.reject(new Error("remote_channel_retry"))
          }
          const count = body.dataChannels?.length ?? 0
          return jsonResponse({
            dataChannels: Array.from({ length: count }, () => ({
              id: dataChannelNewCalls + 10,
            })),
          })
        }
        if (url.endsWith("/api/sfu/tracks"))
          return localTrackResponse(init) ?? jsonResponse({})
        return jsonResponse({})
      }
    )

    const received: unknown[] = []
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("remote-app-room", "alice", "audio", {})
    )
    await waitFor(() => expect(lastFakeWebSocket).not.toBeNull())
    act(() => lastFakeWebSocket?.onopen?.())
    act(() => {
      result.current.subscribeRoomAppMessages((message) =>
        received.push(message)
      )
      lastFakeWebSocket?.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: {
            createdAt: 1,
            expiresAt: Date.now() + 60 * 60 * 1000,
            participants: [
              {
                id: "participant-1",
                name: "Alice",
                kind: "human",
                connected: true,
                joinedAt: 1,
                lastSeenAt: 1,
                media: {
                  sessionId: "session-1",
                  muted: false,
                  fileChannelReady: false,
                  appDataChannelReady: false,
                  tracks: [],
                },
              },
              {
                id: "human-b",
                name: "Bob",
                kind: "human",
                connected: true,
                joinedAt: 1,
                lastSeenAt: 1,
                media: {
                  sessionId: "session-b",
                  muted: false,
                  fileChannelReady: false,
                  appDataChannelReady: true,
                  tracks: [],
                },
              },
            ],
            messages: [],
            liveTranscript: { active: false },
            liveTranscriptSegments: [],
            meetingNotes: { active: false },
            meetingNotesMediaAvailable: false,
            agentVoice: {},
            agentVoiceMediaAvailable: false,
            roomAppsEnabled: true,
          },
        }),
      })
    })

    await waitFor(() =>
      expect(
        FakePeerConnection.dataChannels.filter((channel) =>
          channel.label.endsWith("-subscriber")
        )
      ).toHaveLength(2)
    )
    expect(dataChannelNewCalls).toBeGreaterThanOrEqual(5)
    const remoteChannels = FakePeerConnection.dataChannels.filter((channel) =>
      channel.label.endsWith("-subscriber")
    )
    expect(
      remoteChannels.find((channel) => channel.label.includes("reliable"))
        ?.options
    ).toMatchObject({ ordered: true })
    expect(
      remoteChannels.find((channel) => channel.label.includes("realtime"))
        ?.options
    ).toMatchObject({ ordered: false, maxRetransmits: 0 })

    const reliable = remoteChannels.find((channel) =>
      channel.label.includes("reliable")
    )!
    const realtime = remoteChannels.find((channel) =>
      channel.label.includes("realtime")
    )!
    act(() => {
      reliable.emit("message", {
        data: JSON.stringify({
          protocolVersion: 1,
          appInstanceId,
          lane: "reliable",
          payload: { type: "cursor", sourceParticipantId: "spoofed" },
        }),
      })
      realtime.emit("message", {
        data: JSON.stringify({
          protocolVersion: 1,
          appInstanceId: "test-app:deadbeef",
          lane: "realtime",
          payload: { type: "cursor" },
        }),
      })
    })
    expect(received).toEqual([])

    act(() =>
      reliable.emit("message", {
        data: JSON.stringify({
          protocolVersion: 1,
          appInstanceId,
          lane: "reliable",
          payload: { type: "cursor", x: 1 },
        }),
      })
    )
    expect(received).toMatchObject([
      {
        appInstanceId,
        lane: "reliable",
        sourceParticipantId: "human-b",
        payload: { type: "cursor", x: 1 },
      },
    ])

    const oldRemoteChannels = [...remoteChannels]
    act(() =>
      lastFakeWebSocket?.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: {
            createdAt: 1,
            expiresAt: Date.now() + 60 * 60 * 1000,
            participants: [
              {
                id: "participant-1",
                name: "Alice",
                kind: "human",
                connected: true,
                joinedAt: 1,
                lastSeenAt: 1,
                media: {
                  sessionId: "session-1",
                  muted: false,
                  fileChannelReady: false,
                  appDataChannelReady: false,
                  tracks: [],
                },
              },
              {
                id: "human-b",
                name: "Bob",
                kind: "human",
                connected: true,
                joinedAt: 1,
                lastSeenAt: 1,
                media: {
                  sessionId: "session-b2",
                  muted: false,
                  fileChannelReady: false,
                  appDataChannelReady: true,
                  tracks: [],
                },
              },
            ],
            messages: [],
            liveTranscript: { active: false },
            liveTranscriptSegments: [],
            meetingNotes: { active: false },
            meetingNotesMediaAvailable: false,
            agentVoice: {},
            agentVoiceMediaAvailable: false,
            roomAppsEnabled: true,
          },
        }),
      })
    )
    await waitFor(() =>
      expect(
        FakePeerConnection.dataChannels.filter((channel) =>
          channel.label.endsWith("-subscriber")
        )
      ).toHaveLength(4)
    )
    expect(
      oldRemoteChannels.every((channel) => channel.close.mock.calls.length)
    ).toBeTruthy()
    const currentRemoteChannels = FakePeerConnection.dataChannels.filter(
      (channel) => channel.label.endsWith("-subscriber")
    )
    const currentReliable = currentRemoteChannels
      .filter((channel) => channel.label.includes("reliable"))
      .at(-1)!
    const requestsBeforeRecovery = dataChannelNewCalls
    vi.useFakeTimers()
    act(() => {
      currentReliable.emit("close", {})
      currentReliable.emit("error", {})
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(dataChannelNewCalls).toBe(requestsBeforeRecovery + 1)
    expect(
      FakePeerConnection.dataChannels.filter((channel) =>
        channel.label.endsWith("-subscriber")
      )
    ).toHaveLength(5)
    act(() => currentReliable.emit("close", {}))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(dataChannelNewCalls).toBe(requestsBeforeRecovery + 1)
    unmount()
    expect(
      currentRemoteChannels.every((channel) => channel.close.mock.calls.length)
    ).toBeTruthy()
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
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/sfu/session"))
        return jsonResponse({
          participantId: "human-a",
          participantToken: "participant-token",
          sessionId: "session-a",
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      if (String(input).endsWith("/api/sfu/datachannels/new"))
        return jsonResponse({ dataChannels: [{ id: 1 }] })
      if (String(input).endsWith("/api/sfu/tracks"))
        return localTrackResponse(init) ?? jsonResponse({})
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
            messages: [],
            liveTranscript: {
              active: true,
              producerRuntimeHostId: "host-a",
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

  it("sends a bounded Human task request and refuses a closed socket", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("task-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    expect(
      result.current.sendCollabRequest(" agent-a ", "  TASK_T_MARKER  ")
    ).toBe(true)
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "TASK_T_MARKER",
    })

    socket.readyState = 3
    expect(result.current.sendCollabRequest("agent-a", "TASK_U_MARKER")).toBe(
      false
    )
    unmount()
  })

  it("sends exactly one bounded transient Task interrupt and refuses bad input", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("interrupt-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    expect(result.current.sendTaskInterrupt("task-0001", 42)).toBe(true)
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      type: "task-interrupt",
      taskRequestId: "task-0001",
      turnSequence: 42,
    })
    // An interrupt is a control-plane action: it synthesizes no chat, action,
    // or collaboration message, and it selects no Agent or scope.
    const sentTypes = socket.sent.map((message) => JSON.parse(message).type)
    expect(sentTypes.filter((type) => type === "task-interrupt")).toHaveLength(
      1
    )
    expect(sentTypes).not.toContain("chat")
    expect(sentTypes).not.toContain("action")
    expect(sentTypes).not.toContain("collab-request")

    const sentBeforeInvalid = socket.sent.length
    expect(result.current.sendTaskInterrupt("", 42)).toBe(false)
    expect(result.current.sendTaskInterrupt("   ", 42)).toBe(false)
    expect(result.current.sendTaskInterrupt("t".repeat(65), 42)).toBe(false)
    // #409 exact turn: a click without a positive safe turn sequence can never
    // be bound to one turn, so nothing is written to the socket.
    expect(result.current.sendTaskInterrupt("task-0002", 0)).toBe(false)
    expect(result.current.sendTaskInterrupt("task-0002", -1)).toBe(false)
    expect(result.current.sendTaskInterrupt("task-0002", 1.5)).toBe(false)
    expect(
      result.current.sendTaskInterrupt("task-0002", Number.MAX_SAFE_INTEGER + 1)
    ).toBe(false)
    expect(socket.sent.length).toBe(sentBeforeInvalid)

    socket.readyState = 3
    expect(result.current.sendTaskInterrupt("task-0002", 43)).toBe(false)
    unmount()
  })

  it("sends exactly one structured interrupt & send and refuses incomplete input", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("interrupt-send-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    expect(
      result.current.sendTaskInterruptAndSend(
        "task-0001",
        42,
        "  Try the other approach  "
      )
    ).toBe(true)
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      type: "task-interrupt-and-send",
      taskRequestId: "task-0001",
      turnSequence: 42,
      text: "Try the other approach",
    })
    // One structured command only: the browser never sequences chat + interrupt
    // itself.
    const sentTypes = socket.sent.map((message) => JSON.parse(message).type)
    expect(
      sentTypes.filter((type) => type === "task-interrupt-and-send")
    ).toHaveLength(1)
    expect(sentTypes).not.toContain("chat")
    expect(sentTypes).not.toContain("task-interrupt")

    const sentBefore = socket.sent.length
    expect(
      result.current.sendTaskInterruptAndSend("task-0001", 42, "   ")
    ).toBe(false)
    expect(result.current.sendTaskInterruptAndSend("", 42, "text")).toBe(false)
    expect(
      result.current.sendTaskInterruptAndSend("task-0001", 0, "text")
    ).toBe(false)
    expect(
      result.current.sendTaskInterruptAndSend("task-0001", 1.5, "text")
    ).toBe(false)
    expect(socket.sent.length).toBe(sentBefore)
    unmount()
  })

  /*
   * #409 Task Session Continuation. The browser seam is deliberately thin:
   * one bounded private request, one correlated private result, and NOTHING
   * that looks like chat, an action, or a collaboration request.
   */

  it("sends one bounded private discovery request and resolves its exact result", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("picker-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    const pending = result.current.requestTaskSessions(" agent-pi ", {
      projectToken: "project-token-1",
    })
    const frame = JSON.parse(socket.sent.at(-1) ?? "{}")
    expect(frame).toMatchObject({
      type: "task-session-list",
      targetParticipantId: "agent-pi",
      projectToken: "project-token-1",
    })
    expect(typeof frame.requestId).toBe("string")

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "task-session-list-result",
          requestId: frame.requestId,
          ok: true,
          sessions: [
            {
              token: "session-token-1",
              title: "Fix shooter interpolation",
              projectToken: "project-token-1",
              projectLabel: "~/workspace/free4chat",
            },
          ],
          projects: [
            { token: "project-token-1", label: "~/workspace/free4chat" },
          ],
          hasMore: true,
          nextPageToken: "page-token-1",
        }),
      })
    )
    await expect(pending).resolves.toEqual({
      ok: true,
      page: {
        sessions: [
          {
            token: "session-token-1",
            title: "Fix shooter interpolation",
            projectToken: "project-token-1",
            projectLabel: "~/workspace/free4chat",
          },
        ],
        projects: [
          { token: "project-token-1", label: "~/workspace/free4chat" },
        ],
        hasMore: true,
        nextPageToken: "page-token-1",
      },
    })
    // A discovery request synthesizes no conversation content.
    const types = socket.sent.map((message) => JSON.parse(message).type)
    expect(types.filter((type) => type === "task-session-list")).toHaveLength(1)
    expect(types).not.toContain("chat")
    expect(types).not.toContain("action")
    expect(types).not.toContain("collab-request")
    unmount()
  })

  it("resolves a correlated bounded discovery failure without touching the Room error banner", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("picker-fail-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    const pending = result.current.requestTaskSessions("agent-pi")
    const frame = JSON.parse(socket.sent.at(-1) ?? "{}")
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "task-session-list-result",
          requestId: frame.requestId,
          ok: false,
          error: "session_selection_expired",
        }),
      })
    )
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "session_selection_expired",
    })
    // An unrelated/unknown result can never settle a pending request.
    const other = result.current.requestTaskSessions("agent-pi")
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "task-session-list-result",
          requestId: "not-the-pending-request",
          ok: true,
          sessions: [],
          projects: [],
        }),
      })
    )
    await expect(
      Promise.race([other.then(() => "settled"), Promise.resolve("pending")])
    ).resolves.toBe("pending")
    unmount()
  })

  it("sends one bounded private start and resolves its exact result", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("start-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    const pending = result.current.startTaskWithSession(
      " agent-pi ",
      "session-token-1",
      "  Continue the work  "
    )
    const frame = JSON.parse(socket.sent.at(-1) ?? "{}")
    expect(frame).toMatchObject({
      type: "task-session-start",
      targetParticipantId: "agent-pi",
      sessionToken: "session-token-1",
      summary: "Continue the work",
    })
    // Exactly one structured request: no chat, no action, no collab-request.
    const types = socket.sent.map((message) => JSON.parse(message).type)
    expect(types.filter((type) => type === "task-session-start")).toHaveLength(
      1
    )
    expect(types).not.toContain("collab-request")

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "task-session-start-result",
          requestId: frame.requestId,
          ok: false,
          error: "session_selection_expired",
        }),
      })
    )
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "session_selection_expired",
    })
    unmount()
  })

  it("starts a new Task with only the selected opaque project token", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("project-start-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    const pending = result.current.startTaskWithSession(
      "agent-pi",
      null,
      "  Start in this project  ",
      "project-token-1"
    )
    const frame = JSON.parse(socket.sent.at(-1) ?? "{}")
    expect(frame).toMatchObject({
      type: "task-session-start",
      targetParticipantId: "agent-pi",
      projectToken: "project-token-1",
      summary: "Start in this project",
    })
    expect(frame).not.toHaveProperty("sessionToken")

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "task-session-start-result",
          requestId: frame.requestId,
          ok: true,
        }),
      })
    )
    await expect(pending).resolves.toEqual({ ok: true })
    unmount()
  })

  it("stages a long brief against the exact Task id before selected-project preparation", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const originalFetch = fetchMock.getMockImplementation() as
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/api/room/attachments"))
        return jsonResponse({ attachment: { id: "brief-attachment-1" } })
      return originalFetch!(input, init)
    })
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("project-brief-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    await waitFor(() =>
      expect(result.current.getLocalRoomAuth()).toMatchObject({
        participantId: "human-a",
      })
    )
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())

    const brief = new File(["full task-owned brief"], "task-brief.md", {
      type: "text/markdown",
    })
    const pending = result.current.startTaskWithSession(
      "agent-pi",
      null,
      "Implement this handoff",
      "project-token-1",
      undefined,
      {},
      brief
    )
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/room/attachments")
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(
        socket.sent.some(
          (payload) => JSON.parse(payload).type === "task-session-start"
        )
      ).toBe(true)
    )
    const upload = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/room/attachments")
    )
    expect(upload?.[1]?.body).toBe(brief)
    const headers = new Headers(upload?.[1]?.headers)
    const frame = JSON.parse(socket.sent.at(-1) ?? "{}")
    expect(frame).toMatchObject({
      type: "task-session-start",
      projectToken: "project-token-1",
      taskRequestId: headers.get("X-Task-Request-Id"),
      attachmentIds: ["brief-attachment-1"],
    })
    expect(headers.get("X-Task-Attachment-Pending")).toBe("1")

    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "task-session-start-result",
          requestId: frame.requestId,
          ok: true,
        }),
      })
    )
    await expect(pending).resolves.toEqual({ ok: true })
    unmount()
  })

  it("does not send a timed-out staged brief when a retry starts", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const originalFetch = fetchMock.getMockImplementation() as
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined
    const uploads: Array<(response: Response) => void> = []
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/api/room/attachments"))
        return new Promise<Response>((resolve) => uploads.push(resolve))
      return originalFetch!(input, init)
    })
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("project-brief-timeout-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())
    const brief = new File(["retry-safe brief"], "task-brief.md", {
      type: "text/markdown",
    })

    vi.useFakeTimers()
    try {
      const timedOut = result.current.startTaskWithSession(
        "agent-pi",
        null,
        "Retry-safe brief",
        "project-token-1",
        undefined,
        {},
        brief
      )
      expect(uploads).toHaveLength(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_001)
      })
      await expect(timedOut).resolves.toEqual({
        ok: false,
        error: "session_continuation_unavailable",
      })

      const retry = result.current.startTaskWithSession(
        "agent-pi",
        null,
        "Retry-safe brief",
        "project-token-1",
        undefined,
        {},
        brief
      )
      expect(uploads).toHaveLength(2)
      await act(async () => {
        uploads[1]!(
          (await jsonResponse({
            attachment: { id: "retry-attachment" },
          })) as Response
        )
        await Promise.resolve()
        await Promise.resolve()
      })
      const starts = () =>
        socket.sent
          .map((payload) => JSON.parse(payload))
          .filter((frame) => frame.type === "task-session-start")
      expect(starts()).toHaveLength(1)
      expect(starts()[0].attachmentIds).toEqual(["retry-attachment"])

      await act(async () => {
        uploads[0]!(
          (await jsonResponse({
            attachment: { id: "late-first-attachment" },
          })) as Response
        )
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(starts()).toHaveLength(1)
      expect(starts()[0].attachmentIds).toEqual(["retry-attachment"])
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/room/attachments/discard")
        )
      ).toBe(true)

      act(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "task-session-start-result",
            requestId: starts()[0].requestId,
            ok: true,
          }),
        })
      )
      await expect(retry).resolves.toEqual({ ok: true })
    } finally {
      vi.useRealTimers()
      unmount()
    }
  })

  it("starts the Runtime reply timeout only after brief staging completes", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const originalFetch = fetchMock.getMockImplementation() as
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined
    let finishUpload: ((response: Response) => void) | undefined
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith("/api/room/attachments"))
        return new Promise<Response>((resolve) => {
          finishUpload = resolve
        })
      return originalFetch!(input)
    })
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("project-brief-response-timeout-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    await waitFor(() =>
      expect(result.current.getLocalRoomAuth()).toMatchObject({
        participantId: "human-a",
      })
    )
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())
    const brief = new File(["staged later"], "task-brief.md", {
      type: "text/markdown",
    })
    vi.useFakeTimers()
    try {
      let completed = false
      const pending = result.current.startTaskWithSession(
        "agent-pi",
        null,
        "Start with the brief",
        "project-token-1",
        undefined,
        {},
        brief
      )
      void pending.then(() => {
        completed = true
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      await act(async () => {
        finishUpload?.(
          (await jsonResponse({
            attachment: { id: "staged-before-prepare" },
          })) as Response
        )
        await Promise.resolve()
        await Promise.resolve()
      })
      const frame = JSON.parse(socket.sent.at(-1) ?? "{}")
      expect(frame.type).toBe("task-session-start")
      await act(async () => {
        await vi.advanceTimersByTimeAsync(24_000)
      })
      expect(completed).toBe(false)
      act(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "task-session-start-result",
            requestId: frame.requestId,
            ok: true,
          }),
        })
      )
      await expect(pending).resolves.toEqual({ ok: true })
    } finally {
      vi.useRealTimers()
      unmount()
    }
  })

  it("returns a failed start without waiting for best-effort brief cleanup", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const originalFetch = fetchMock.getMockImplementation() as
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/api/room/attachments"))
        return jsonResponse({ attachment: { id: "failed-start-brief" } })
      if (String(input).endsWith("/api/room/attachments/discard"))
        return new Promise<Response>(() => undefined)
      return originalFetch!(input, init)
    })
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("project-brief-cleanup-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    await waitFor(() =>
      expect(result.current.getLocalRoomAuth()).toMatchObject({
        participantId: "human-a",
      })
    )
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())
    const pending = result.current.startTaskWithSession(
      "agent-pi",
      null,
      "Start the brief",
      "project-token-1",
      undefined,
      {},
      new File(["brief"], "task-brief.md", { type: "text/markdown" })
    )
    await waitFor(() =>
      expect(
        socket.sent.some(
          (payload) => JSON.parse(payload).type === "task-session-start"
        )
      ).toBe(true)
    )
    const frame = JSON.parse(socket.sent.at(-1) ?? "{}")
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "task-session-start-result",
          requestId: frame.requestId,
          ok: false,
          error: "session_selection_expired",
        }),
      })
    )
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "session_selection_expired",
    })
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/api/room/attachments/discard")
      )
    ).toBe(true)
    unmount()
  })

  it("does not send a brief when its socket closes during staging", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const originalFetch = fetchMock.getMockImplementation() as
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined
    let finishUpload: ((response: Response) => void) | undefined
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/api/room/attachments"))
        return new Promise<Response>((resolve) => {
          finishUpload = resolve
        })
      return originalFetch!(input, init)
    })
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("project-brief-cancel-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const firstSocket = RecordingWebSocket.instances[0]
    act(() => firstSocket.onopen?.())
    const brief = new File(["cancel-safe brief"], "task-brief.md", {
      type: "text/markdown",
    })

    vi.useFakeTimers()
    try {
      const pending = result.current.startTaskWithSession(
        "agent-pi",
        null,
        "Cancel-safe brief",
        "project-token-1",
        undefined,
        {},
        brief
      )
      expect(finishUpload).toBeTypeOf("function")
      act(() => firstSocket.onclose?.())
      await expect(pending).resolves.toEqual({
        ok: false,
        error: "session_continuation_unavailable",
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(RecordingWebSocket.instances).toHaveLength(2)
      const reconnectedSocket = RecordingWebSocket.instances[1]
      act(() => reconnectedSocket.onopen?.())

      await act(async () => {
        finishUpload!(
          (await jsonResponse({
            attachment: { id: "cancelled-attachment" },
          })) as Response
        )
        await Promise.resolve()
        await Promise.resolve()
      })
      const starts = RecordingWebSocket.instances.flatMap((socket) =>
        socket.sent
          .map((payload) => JSON.parse(payload))
          .filter((frame) => frame.type === "task-session-start")
      )
      expect(starts).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      unmount()
    }
  })

  it("refuses a private session request without writing to a closed socket", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("closed-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())
    const sentBefore = socket.sent.length
    socket.readyState = 3

    await expect(
      result.current.requestTaskSessions("agent-pi")
    ).resolves.toEqual({
      ok: false,
      error: "session_continuation_unavailable",
    })
    await expect(
      result.current.startTaskWithSession("agent-pi", "session-token-1", "go")
    ).resolves.toEqual({
      ok: false,
      error: "session_continuation_unavailable",
    })
    expect(socket.sent.length).toBe(sentBefore)
    unmount()
  })

  it("refuses a malformed private start before writing to the socket", async () => {
    const { result, unmount } = renderHook(() =>
      useSfuChatRoom("malformed-room", "Guest", "audio")
    )
    await waitFor(() => expect(RecordingWebSocket.instances).toHaveLength(1))
    const socket = RecordingWebSocket.instances[0]
    act(() => socket.onopen?.())
    const sentBefore = socket.sent.length

    await expect(
      result.current.startTaskWithSession("", "session-token-1", "go")
    ).resolves.toEqual({ ok: false, error: "invalid_session_control" })
    await expect(
      result.current.startTaskWithSession("agent-pi", "", "go")
    ).resolves.toEqual({ ok: false, error: "invalid_session_control" })
    await expect(
      result.current.startTaskWithSession("agent-pi", "t".repeat(65), "go")
    ).resolves.toEqual({ ok: false, error: "invalid_session_control" })
    expect(socket.sent.length).toBe(sentBefore)
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

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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
        return localTrackResponse(init) ?? jsonResponse({})
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
          return localTrackResponse(init)
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
          return localTrackResponse(init)
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
          if (body.tracks?.[0]?.location !== "remote")
            return localTrackResponse(init) ?? jsonResponse({})
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
          if (body.tracks?.[0]?.location !== "remote")
            return localTrackResponse(init) ?? jsonResponse({})
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
