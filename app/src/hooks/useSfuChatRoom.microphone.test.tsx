import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useSfuChatRoom } from "./useSfuChatRoom"
import type { SfuRoomState } from "../sfu/types"

/**
 * #402: Human voice is opt-in and Room-owned.
 *
 * Entering a Room must never request the microphone; capture starts only from
 * an explicit Human action, denial never fails the Room, a media reconnect
 * never re-acquires the device silently, and mute/unmute never touches the
 * device again. These regressions are the contract behind the Room-level mic
 * control, so they live next to the hook that owns the lifecycle.
 */

class TestTrack {
  enabled = true
  readyState: "live" | "ended" = "live"
  onended: (() => void) | null = null
  stop = vi.fn(() => {
    this.readyState = "ended"
  })

  constructor(public kind: "audio" | "video") {}
}

class TestMediaStream {
  constructor(private readonly tracks: TestTrack[] = []) {}

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio")
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video")
  }

  getTracks() {
    return this.tracks
  }
}

type DataChannelHandler = (event: unknown) => void

class TestDataChannel {
  binaryType = ""
  bufferedAmountLowThreshold = 0
  bufferedAmount = 0
  readyState: "connecting" | "open" | "closing" | "closed" = "open"
  listeners = new Map<string, Set<DataChannelHandler>>()
  send = vi.fn()
  close = vi.fn(() => {
    if (this.readyState === "closed") return
    this.readyState = "closed"
    this.emit("close")
  })

  constructor(public readonly name: string) {}

  addEventListener(type: string, handler: DataChannelHandler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(handler)
  }

  removeEventListener(type: string, handler: DataChannelHandler) {
    this.listeners.get(type)?.delete(handler)
  }

  emit(type: string, event: unknown = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

class TestPeerConnection {
  static instances: TestPeerConnection[] = []
  connectionState = "connected"
  ontrack: ((event: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  createdChannels: TestDataChannel[] = []
  private mids = 0
  private readonly transceivers: Array<{
    sender: { track: TestTrack | null }
    mid: string
    direction: "sendonly" | "recvonly" | "sendrecv"
  }> = []

  constructor() {
    TestPeerConnection.instances.push(this)
  }

  addTrack(track: TestTrack) {
    const mid = String(this.mids++)
    this.transceivers.push({ sender: { track }, mid, direction: "sendrecv" })
    return { track }
  }

  addTransceiver(
    track: TestTrack | null,
    init: { direction?: "sendonly" | "recvonly" } = {}
  ) {
    const transceiver = {
      sender: { track },
      mid: String(this.mids++),
      direction: init.direction ?? "sendonly",
    }
    this.transceivers.push(transceiver)
    return transceiver
  }

  getTransceivers() {
    return this.transceivers
  }

  getSenders() {
    return this.transceivers.map((transceiver) => transceiver.sender)
  }

  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "test-offer" })
  }

  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "test-answer" })
  }

  setLocalDescription() {
    return Promise.resolve()
  }

  setRemoteDescription() {
    return Promise.resolve()
  }

  createDataChannel(name: string) {
    const channel = new TestDataChannel(name)
    this.createdChannels.push(channel)
    return channel
  }

  removeTrack() {}

  close() {
    this.connectionState = "closed"
  }
}

class TestWebSocket {
  static OPEN = 1
  static instances: TestWebSocket[] = []
  readyState = TestWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(public readonly url: string) {
    TestWebSocket.instances.push(this)
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

function humanParticipant(
  id: string,
  options: { muted?: boolean } = {}
): SfuRoomState["participants"][number] {
  return {
    id,
    name: id,
    kind: "human",
    connected: true,
    joinedAt: 0,
    lastSeenAt: 0,
    media: {
      sessionId: `session-${id}`,
      muted: options.muted ?? false,
      fileChannelReady: true,
      tracks: [],
    },
  }
}

function roomState(participants: SfuRoomState["participants"]): SfuRoomState {
  return {
    createdAt: 0,
    expiresAt: Date.now() + 60 * 60 * 1000,
    participants,
    messages: [],
    meetingNotes: { active: false },
    meetingNotesMediaAvailable: false,
    agentVoice: {},
    agentVoiceMediaAvailable: false,
  }
}

describe("useSfuChatRoom microphone lifecycle (#402)", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let getUserMedia: ReturnType<typeof vi.fn>
  let getDisplayMedia: ReturnType<typeof vi.fn>
  let sessionNumber: number
  let localAudioTrack: TestTrack | null

  beforeEach(() => {
    TestPeerConnection.instances.length = 0
    TestWebSocket.instances.length = 0
    sessionNumber = 0
    localAudioTrack = null
    ;(global as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      TestPeerConnection
    ;(global as unknown as { MediaStream: unknown }).MediaStream =
      TestMediaStream
    ;(global as unknown as { WebSocket: unknown }).WebSocket = TestWebSocket
    getUserMedia = vi.fn(async () => {
      localAudioTrack = new TestTrack("audio")
      return new TestMediaStream([localAudioTrack])
    })
    getDisplayMedia = vi.fn(async () => {
      return new TestMediaStream([new TestTrack("video")])
    })
    Object.defineProperty(global.navigator, "mediaDevices", {
      value: { getUserMedia, getDisplayMedia },
      configurable: true,
    })
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/sfu/session")) {
        sessionNumber += 1
        return jsonResponse({
          participantId: "human-local",
          participantToken: "participant-token",
          sessionId: `subscriber-session-${sessionNumber}`,
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      }
      if (url.endsWith("/api/sfu/datachannels/establish"))
        return jsonResponse({})
      if (url.endsWith("/api/sfu/datachannels/new")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          dataChannels?: Array<{ location?: string }>
        }
        const count = body.dataChannels?.length ?? 1
        return jsonResponse({
          dataChannels: Array.from({ length: count }, (_, index) => ({
            id: index + 1,
          })),
        })
      }
      if (url.endsWith("/api/sfu/tracks")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          tracks: Array<{ location?: string; trackName: string; mid?: string }>
        }
        if (body.tracks[0].location !== "remote")
          return jsonResponse({
            sessionDescription: { type: "answer", sdp: "local-answer" },
            tracks: [
              {
                mid: body.tracks[0].mid ?? "local-mid",
                trackName: body.tracks[0].trackName,
              },
            ],
          })
        return jsonResponse({})
      }
      return jsonResponse({})
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const localPublishRequests = () =>
    fetchMock.mock.calls
      .filter(([input, init]) => {
        if (!String(input).endsWith("/api/sfu/tracks")) return false
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          tracks?: Array<{ location?: string; kind?: string }>
        }
        return body.tracks?.[0]?.location === "local"
      })
      .map(
        ([, init]) =>
          JSON.parse(String(init?.body ?? "{}")) as {
            tracks: Array<{ kind: string; mid: string; trackName: string }>
          }
      )

  const sentMessages = (socket: TestWebSocket) =>
    socket.sent.map(
      (raw) => JSON.parse(raw) as { type: string; muted?: boolean }
    )

  async function connect() {
    const hook = renderHook(() => useSfuChatRoom("mic-room", "Alice", "audio"))
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))
    const socket = TestWebSocket.instances[0]
    act(() => socket.onopen?.())
    return { ...hook, socket, pc: TestPeerConnection.instances[0] }
  }

  function sendRoomState(
    socket: TestWebSocket,
    participants: SfuRoomState["participants"]
  ) {
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({ type: "state", state: roomState(participants) }),
      })
    )
  }

  async function enableMic(result: {
    current: { toggleMicrophone: () => void }
  }) {
    await act(async () => {
      result.current.toggleMicrophone()
    })
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
  }

  async function reconnectMedia(pc: TestPeerConnection) {
    await act(async () => {
      pc.connectionState = "failed"
      pc.onconnectionstatechange?.()
    })
    await waitFor(() =>
      expect(TestPeerConnection.instances.length).toBeGreaterThan(1)
    )
    const next =
      TestPeerConnection.instances[TestPeerConnection.instances.length - 1]
    const socket = TestWebSocket.instances[TestWebSocket.instances.length - 1]
    act(() => socket.onopen?.())
    return { pc: next, socket }
  }

  it("joins a Room without ever requesting the microphone", async () => {
    const { result, socket, unmount } = await connect()

    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )
    sendRoomState(socket, [humanParticipant("human-local")])
    await waitFor(() =>
      expect(
        result.current.participants.some(
          (participant) => participant.peerId === "local-peer"
        )
      ).toBe(true)
    )
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(localPublishRequests()).toHaveLength(0)
    expect(result.current.localMicState).toBe("not_enabled")
    // The Room-visible projection is truthful: no local voice capability reads
    // as "not speaking", never as a live microphone.
    const local = result.current.participants.find(
      (participant) => participant.peerId === "local-peer"
    )
    expect(local).toBeDefined()
    expect(local!.audioStream ?? null).toBeNull()
    expect(local!.muteState).toBe(true)
    // The Room is told that this Human is not speaking.
    expect(sentMessages(socket)).toContainEqual({ type: "mute", muted: true })
    unmount()
  })

  it("keeps a non-voice Room session usable with zero microphone requests", async () => {
    const { result, socket, unmount } = await connect()
    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )

    act(() => {
      result.current.sendTextMessage("hello without a microphone")
    })
    expect(
      sentMessages(socket).some((message) => message.type === "chat")
    ).toBe(true)

    // Screen share is the other dynamic Human publication and must work with
    // no microphone at all.
    await act(async () => {
      await result.current.toggleScreenShare()
    })
    await waitFor(() =>
      expect(
        localPublishRequests().some(
          (request) => request.tracks[0].kind === "video"
        )
      ).toBe(true)
    )

    unmount()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it("enables the microphone only on explicit action and publishes it", async () => {
    const { result, socket, pc, unmount } = await connect()
    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )

    await enableMic(result)

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
    expect(result.current.localMicState).toBe("live")

    // The granted track is attached to the EXISTING PeerConnection through a
    // dedicated sendonly transceiver and published on the same session.
    const micTrack = localAudioTrack!
    const transceiver = pc
      .getTransceivers()
      .find((candidate) => candidate.sender.track === micTrack)
    expect(transceiver).toBeDefined()
    expect(transceiver!.direction).toBe("sendonly")

    await waitFor(() => expect(localPublishRequests()).toHaveLength(1))
    const publish = localPublishRequests()[0]
    expect(publish.tracks[0].kind).toBe("audio")
    expect(publish.tracks[0].mid).toBe(transceiver!.mid)

    const local = result.current.participants.find(
      (participant) => participant.peerId === "local-peer"
    )
    expect(local!.audioStream ?? null).not.toBeNull()
    expect(local!.muteState).toBe(false)
    expect(sentMessages(socket)).toContainEqual({ type: "mute", muted: false })
    unmount()
  })

  it("keeps the Room usable when microphone permission is denied", async () => {
    const { result, socket, unmount } = await connect()
    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )
    getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" })
    )

    await act(async () => {
      result.current.toggleMicrophone()
    })
    await waitFor(() =>
      expect(result.current.localMicState).toBe("unavailable")
    )

    expect(result.current.connectionStatus).toBe("connected")
    expect(result.current.error).toBe("")
    expect(localPublishRequests()).toHaveLength(0)
    expect(TestPeerConnection.instances).toHaveLength(1)
    act(() => {
      result.current.sendTextMessage("still here")
    })
    expect(
      sentMessages(socket).some((message) => message.type === "chat")
    ).toBe(true)
    // No background retry: the next attempt is another explicit Human action.
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("mutes and unmutes the same live track without reacquiring the device", async () => {
    const { result, socket, unmount } = await connect()
    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )
    await enableMic(result)
    const micTrack = localAudioTrack!

    act(() => result.current.toggleMicrophone())
    expect(micTrack.enabled).toBe(false)
    expect(result.current.localMicState).toBe("muted")
    expect(sentMessages(socket)).toContainEqual({ type: "mute", muted: true })

    act(() => result.current.toggleMicrophone())
    expect(micTrack.enabled).toBe(true)
    expect(result.current.localMicState).toBe("live")
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(localAudioTrack).toBe(micTrack)
    unmount()
  })

  it("reconnects without a microphone when voice was never enabled", async () => {
    const { result, pc, unmount } = await connect()
    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )

    await reconnectMedia(pc)

    expect(getUserMedia).not.toHaveBeenCalled()
    expect(result.current.localMicState).toBe("not_enabled")
    expect(
      localPublishRequests().filter(
        (request) => request.tracks[0].kind === "audio"
      )
    ).toHaveLength(0)
    unmount()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it("reuses the live track across a media reconnect and preserves mute", async () => {
    const { result, unmount } = await connect()
    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )
    await enableMic(result)
    const micTrack = localAudioTrack!
    act(() => result.current.toggleMicrophone())
    expect(result.current.localMicState).toBe("muted")

    const { pc: reconnectedPc, socket: reconnectedSocket } =
      await reconnectMedia(TestPeerConnection.instances[0])

    // No second permission request, same track, mute intent preserved.
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(
      reconnectedPc
        .getTransceivers()
        .some((candidate) => candidate.sender.track === micTrack)
    ).toBe(true)
    expect(micTrack.enabled).toBe(false)
    expect(result.current.localMicState).toBe("muted")
    expect(sentMessages(reconnectedSocket)).toContainEqual({
      type: "mute",
      muted: true,
    })
    await waitFor(() =>
      expect(
        localPublishRequests().filter(
          (request) => request.tracks[0].kind === "audio"
        ).length
      ).toBeGreaterThanOrEqual(2)
    )
    unmount()
  })

  it("does not silently reacquire the microphone when the granted track ends", async () => {
    const { result, socket, unmount } = await connect()
    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )
    await enableMic(result)
    const micTrack = localAudioTrack!

    act(() => {
      micTrack.readyState = "ended"
      micTrack.onended?.()
    })

    expect(result.current.localMicState).toBe("not_enabled")
    expect(result.current.connectionStatus).toBe("connected")
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(sentMessages(socket)).toContainEqual({ type: "mute", muted: true })
    const local = result.current.participants.find(
      (participant) => participant.peerId === "local-peer"
    )
    expect(local!.audioStream ?? null).toBeNull()

    // Recovery is another explicit Human action, not a background retry.
    await enableMic(result)
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(result.current.localMicState).toBe("live")
    unmount()
  })

  it("does not reacquire the microphone when reconnecting after the track ended", async () => {
    const { result, pc, unmount } = await connect()
    await waitFor(() =>
      expect(result.current.connectionStatus).toBe("connected")
    )
    await enableMic(result)
    const micTrack = localAudioTrack!

    act(() => {
      micTrack.readyState = "ended"
      micTrack.onended?.()
    })
    await reconnectMedia(pc)

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(result.current.localMicState).toBe("not_enabled")
    expect(
      localPublishRequests().filter(
        (request) => request.tracks[0].kind === "audio"
      )
    ).toHaveLength(1)
    unmount()
  })
})
