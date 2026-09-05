import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useSfuChatRoom } from "./useSfuChatRoom"
import type { SfuRoomState, SfuTrack } from "../sfu/types"

class TestTrack {
  enabled = true
  readyState = "live"
  stop = vi.fn()

  constructor(public kind: "audio" | "video") {}
}

class TestMediaStream {
  constructor(private readonly tracks: TestTrack[] = []) {}

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio")
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
  send = vi.fn((data: string) => {
    if (this.readyState !== "open") throw new Error("channel is not open")
    return data
  })
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
  static remoteDescriptionFailures = 0
  connectionState = "connected"
  ontrack: ((event: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  createdChannels: TestDataChannel[] = []
  private mids = 0
  private readonly transceivers: Array<{
    sender: { track: TestTrack }
    mid: string
  }> = []

  constructor() {
    TestPeerConnection.instances.push(this)
  }

  addTrack(track: TestTrack) {
    const mid = String(this.mids++)
    this.transceivers.push({ sender: { track }, mid })
    return { track }
  }

  getTransceivers() {
    return this.transceivers
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
    if (TestPeerConnection.remoteDescriptionFailures > 0) {
      TestPeerConnection.remoteDescriptionFailures -= 1
      return Promise.reject(new Error("remote description failed"))
    }
    return Promise.resolve()
  }

  createDataChannel(name: string) {
    const channel = new TestDataChannel(name)
    TestPeerConnection.channelFactory?.(channel)
    this.createdChannels.push(channel)
    return channel
  }

  removeTrack() {}

  close() {
    this.connectionState = "closed"
  }

  static channelFactory: ((channel: TestDataChannel) => void) | null = null
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

type Participant = SfuRoomState["participants"][number]

function participant(
  id: string,
  tracks: SfuTrack[],
  sessionId = `publisher-${id}`,
  fileChannelReady = false
): Participant {
  return {
    id,
    name: id,
    kind: "human",
    connected: true,
    joinedAt: 0,
    lastSeenAt: 0,
    media: {
      sessionId,
      muted: false,
      fileChannelReady,
      tracks,
    },
  }
}

function roomState(participants: Participant[]): SfuRoomState {
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

function sendState(socket: TestWebSocket, state: SfuRoomState) {
  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({ type: "state", state }),
    })
  )
}

function sendTrackPublished(
  socket: TestWebSocket,
  id: string,
  sessionId: string,
  track: SfuTrack
) {
  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({
        type: "trackPublished",
        participant: {
          id,
          name: id,
          kind: "human",
          sessionId,
          track,
        },
      }),
    })
  )
}

function deliverTrack(
  pc: TestPeerConnection,
  mid: string,
  kind: "audio" | "video",
  stream = new TestMediaStream([new TestTrack(kind)])
) {
  act(() =>
    pc.ontrack?.({
      track: stream.getTracks()[0],
      streams: [stream],
      transceiver: { mid },
    })
  )
  return stream
}

describe("useSfuChatRoom remote SFU subscriber reliability", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let sessionNumber: number
  let trackRequestNumber: number
  let remoteChannelNumber: number
  let transientRemoteTrackResponses: number

  beforeEach(() => {
    TestPeerConnection.instances.length = 0
    TestPeerConnection.channelFactory = null
    TestPeerConnection.remoteDescriptionFailures = 0
    TestWebSocket.instances.length = 0
    sessionNumber = 0
    trackRequestNumber = 0
    remoteChannelNumber = 100
    transientRemoteTrackResponses = 0
    ;(global as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      TestPeerConnection
    ;(global as unknown as { MediaStream: unknown }).MediaStream =
      TestMediaStream
    ;(global as unknown as { WebSocket: unknown }).WebSocket = TestWebSocket
    Object.defineProperty(global.navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [new TestTrack("audio")],
        }),
      },
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
        const isLocal = body.dataChannels?.[0]?.location === "local"
        return jsonResponse({
          dataChannels: [{ id: isLocal ? 1 : remoteChannelNumber++ }],
        })
      }
      if (url.endsWith("/api/sfu/tracks")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          tracks: Array<{ location?: string; trackName: string }>
        }
        if (body.tracks[0].location !== "remote") return jsonResponse({})
        trackRequestNumber += 1
        if (transientRemoteTrackResponses > 0) {
          transientRemoteTrackResponses -= 1
          return jsonResponse({
            tracks: [{ errorCode: "empty_track_error" }],
          })
        }
        return jsonResponse({
          sessionDescription: { type: "offer", sdp: "remote-offer" },
          tracks: [
            {
              mid: `remote-mid-${trackRequestNumber}`,
              trackName: body.tracks[0].trackName,
            },
          ],
        })
      }
      return jsonResponse({})
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function connect() {
    const hook = renderHook(() =>
      useSfuChatRoom("reliability-room", "Alice", "audio")
    )
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))
    const socket = TestWebSocket.instances[0]
    act(() => socket.onopen?.())
    return { ...hook, socket, pc: TestPeerConnection.instances[0] }
  }

  async function waitForRemoteTrackRequests(count: number) {
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input, init]) => {
          if (!String(input).endsWith("/api/sfu/tracks")) return false
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            tracks?: Array<{ location?: string }>
          }
          return body.tracks?.[0]?.location === "remote"
        })
      ).toHaveLength(count)
    )
  }

  async function flushAsync() {
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
  }

  it("correlates two video publishers by MID even when ontrack order is reversed", async () => {
    const { result, socket, pc, unmount } = await connect()
    sendState(
      socket,
      roomState([
        participant("publisher-a", [{ trackName: "screen-a", kind: "video" }]),
        participant("publisher-b", [{ trackName: "screen-b", kind: "video" }]),
      ])
    )
    await waitForRemoteTrackRequests(2)

    const streamB = deliverTrack(pc, "remote-mid-2", "video")
    const streamA = deliverTrack(pc, "remote-mid-1", "video")
    await waitFor(() => {
      expect(
        result.current.participants.find(
          (entry) => entry.peerId === "publisher-a"
        )?.screenShareStream
      ).toBe(streamA)
      expect(
        result.current.participants.find(
          (entry) => entry.peerId === "publisher-b"
        )?.screenShareStream
      ).toBe(streamB)
    })
    unmount()
  })

  it("keeps mixed audio and video subscriptions independent across publishers", async () => {
    const { result, socket, pc, unmount } = await connect()
    sendState(
      socket,
      roomState([
        participant("publisher-a", [
          { trackName: "audio-a", kind: "audio" },
          { trackName: "screen-a", kind: "video" },
        ]),
        participant("publisher-b", [
          { trackName: "audio-b", kind: "audio" },
          { trackName: "screen-b", kind: "video" },
        ]),
      ])
    )
    await waitForRemoteTrackRequests(4)

    const stream4 = deliverTrack(pc, "remote-mid-4", "video")
    const stream1 = deliverTrack(pc, "remote-mid-1", "audio")
    const stream3 = deliverTrack(pc, "remote-mid-3", "audio")
    const stream2 = deliverTrack(pc, "remote-mid-2", "video")
    await waitFor(() => {
      const publisherA = result.current.participants.find(
        (entry) => entry.peerId === "publisher-a"
      )
      const publisherB = result.current.participants.find(
        (entry) => entry.peerId === "publisher-b"
      )
      expect(publisherA?.audioStream).toBe(stream1)
      expect(publisherA?.screenShareStream).toBe(stream2)
      expect(publisherB?.audioStream).toBe(stream3)
      expect(publisherB?.screenShareStream).toBe(stream4)
    })
    unmount()
  })

  it("waits for a connected PeerConnection before replaying initial remote media", async () => {
    const { socket, pc, unmount } = await connect()
    pc.connectionState = "new"
    const state = roomState([
      participant(
        "publisher-a",
        [{ trackName: "screen-a", kind: "video" }],
        "session-a",
        true
      ),
    ])

    sendState(socket, state)
    await flushAsync()
    expect(trackRequestNumber).toBe(0)
    expect(
      fetchMock.mock.calls.filter(([input, init]) => {
        if (!String(input).endsWith("/api/sfu/datachannels/new")) return false
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          dataChannels?: Array<{ location?: string }>
        }
        return body.dataChannels?.[0]?.location === "remote"
      })
    ).toHaveLength(0)

    act(() => {
      pc.connectionState = "connected"
      pc.onconnectionstatechange?.()
    })
    await waitForRemoteTrackRequests(1)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input, init]) => {
          if (!String(input).endsWith("/api/sfu/datachannels/new")) return false
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            dataChannels?: Array<{ location?: string }>
          }
          return body.dataChannels?.[0]?.location === "remote"
        })
      ).toHaveLength(1)
    )
    unmount()
  })

  it("retries a Human video subscription after a transient track admission failure", async () => {
    const { result, socket, pc, unmount } = await connect()
    transientRemoteTrackResponses = 1
    vi.useFakeTimers()
    sendState(
      socket,
      roomState([
        participant("publisher-a", [{ trackName: "screen-a", kind: "video" }]),
      ])
    )
    await flushAsync()
    expect(trackRequestNumber).toBe(1)
    expect(
      result.current.participants.find(
        (entry) => entry.peerId === "publisher-a"
      )?.screenShareStream
    ).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
      await flushAsync()
    })
    expect(trackRequestNumber).toBe(2)

    const stream = deliverTrack(pc, "remote-mid-2", "video")
    await flushAsync()
    expect(
      result.current.participants.find(
        (entry) => entry.peerId === "publisher-a"
      )?.screenShareStream
    ).toBe(stream)
    unmount()
  })

  it("does not retry a Human track after a mid has been admitted", async () => {
    const { socket, unmount } = await connect()
    TestPeerConnection.remoteDescriptionFailures = 1
    sendState(
      socket,
      roomState([
        participant("publisher-a", [{ trackName: "screen-a", kind: "video" }]),
      ])
    )
    await waitForRemoteTrackRequests(1)
    await flushAsync()
    vi.useFakeTimers()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await flushAsync()
    })
    sendState(
      socket,
      roomState([
        participant("publisher-a", [{ trackName: "screen-a", kind: "video" }]),
      ])
    )
    await flushAsync()
    expect(trackRequestNumber).toBe(1)
    unmount()
  })

  it("ignores a delayed event from a rotated publisher session", async () => {
    const { result, socket, pc, unmount } = await connect()
    const oldTrack = { trackName: "screen", kind: "video" } as const
    sendState(
      socket,
      roomState([participant("publisher-a", [oldTrack], "session-old")])
    )
    await waitForRemoteTrackRequests(1)

    sendState(
      socket,
      roomState([participant("publisher-a", [oldTrack], "session-new")])
    )
    await waitForRemoteTrackRequests(2)

    deliverTrack(pc, "remote-mid-1", "video")
    await waitFor(() =>
      expect(
        result.current.participants.find(
          (entry) => entry.peerId === "publisher-a"
        )?.screenShareStream
      ).toBeNull()
    )
    const newStream = deliverTrack(pc, "remote-mid-2", "video")
    await waitFor(() =>
      expect(
        result.current.participants.find(
          (entry) => entry.peerId === "publisher-a"
        )?.screenShareStream
      ).toBe(newStream)
    )
    unmount()
  })

  it("releases a timed-out track admission so a later resync can retry", async () => {
    const { socket, pc, unmount } = await connect()
    vi.useFakeTimers()
    const state = roomState([
      participant("publisher-a", [{ trackName: "screen-a", kind: "video" }]),
    ])
    sendState(socket, state)
    await flushAsync()
    expect(trackRequestNumber).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    sendState(socket, state)
    await flushAsync()
    expect(trackRequestNumber).toBe(2)
    expect(pc.ontrack).not.toBeNull()
    unmount()
  })

  it("clears old bindings on PeerConnection replacement before accepting the new session", async () => {
    const { result, socket, pc: oldPc, unmount } = await connect()
    const state = roomState([
      participant("publisher-a", [{ trackName: "screen-a", kind: "video" }]),
    ])
    sendState(socket, state)
    await waitForRemoteTrackRequests(1)

    oldPc.connectionState = "disconnected"
    act(() => oldPc.onconnectionstatechange?.())
    await waitFor(() => expect(TestPeerConnection.instances).toHaveLength(2))
    const newPc = TestPeerConnection.instances[1]
    const newSocket = TestWebSocket.instances[1]
    deliverTrack(oldPc, "remote-mid-1", "video")
    expect(
      result.current.participants.find(
        (entry) => entry.peerId === "publisher-a"
      )?.screenShareStream
    ).toBeNull()

    sendState(newSocket, state)
    await waitForRemoteTrackRequests(2)
    const newStream = deliverTrack(newPc, "remote-mid-2", "video")
    await waitFor(() =>
      expect(
        result.current.participants.find(
          (entry) => entry.peerId === "publisher-a"
        )?.screenShareStream
      ).toBe(newStream)
    )
    unmount()
  })

  it("treats a newly published file channel as an independent retryable attempt", async () => {
    const { socket, unmount } = await connect()
    const state = roomState([
      participant("publisher-a", [], "session-a", true),
      participant("publisher-b", [], "session-b", true),
    ])
    sendState(socket, state)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).endsWith("/api/sfu/datachannels/new")
        )
      ).toHaveLength(3)
    )
    const channels = TestPeerConnection.instances[0].createdChannels
    const remoteA = channels.find((channel) =>
      channel.name.includes("files-publisher-a-subscriber")
    )
    const remoteB = channels.find((channel) =>
      channel.name.includes("files-publisher-b-subscriber")
    )
    expect(remoteA?.send).toHaveBeenCalledWith("ack")
    expect(remoteB?.send).toHaveBeenCalledWith("ack")
    remoteA?.emit("close")

    sendState(socket, state)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).endsWith("/api/sfu/datachannels/new")
        )
      ).toHaveLength(4)
    )
    expect(remoteB?.send).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("cleans up a file channel that never opens and allows a later retry", async () => {
    let channelNumber = 0
    TestPeerConnection.channelFactory = (channel) => {
      if (channel.name.includes("subscriber")) {
        channelNumber += 1
        if (channelNumber === 1) channel.readyState = "connecting"
      }
    }
    const { socket, unmount } = await connect()
    vi.useFakeTimers()
    const state = roomState([participant("publisher-a", [], "session-a", true)])
    sendState(socket, state)
    await flushAsync()
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/sfu/datachannels/new")
      )
    ).toHaveLength(2)
    const firstAttempt = TestPeerConnection.instances[0].createdChannels.find(
      (channel) => channel.name.includes("subscriber")
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(firstAttempt?.close).toHaveBeenCalled()
    sendState(socket, state)
    await flushAsync()
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/sfu/datachannels/new")
      )
    ).toHaveLength(3)
    unmount()
  })

  it("cleans up a pre-ready file channel error and retries without affecting another subscriber", async () => {
    let channelNumber = 0
    TestPeerConnection.channelFactory = (channel) => {
      if (channel.name.includes("subscriber")) {
        channelNumber += 1
        if (channelNumber === 1) channel.readyState = "connecting"
      }
    }
    const { socket, unmount } = await connect()
    const state = roomState([
      participant("publisher-a", [], "session-a", true),
      participant("publisher-b", [], "session-b", true),
    ])
    sendState(socket, state)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).endsWith("/api/sfu/datachannels/new")
        )
      ).toHaveLength(3)
    )
    const channels = TestPeerConnection.instances[0].createdChannels.filter(
      (channel) => channel.name.includes("subscriber")
    )
    channels[0].emit("error")
    expect(channels[0].close).toHaveBeenCalled()
    expect(channels[1].send).toHaveBeenCalledWith("ack")

    sendState(socket, state)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).endsWith("/api/sfu/datachannels/new")
        )
      ).toHaveLength(4)
    )
    unmount()
  })

  it("orders a received file by Room sequence anchor despite sender clock skew", async () => {
    const { result, socket, unmount } = await connect()
    const state = roomState([participant("publisher-a", [], "session-a", true)])
    sendState(socket, state)
    await waitFor(() =>
      expect(
        TestPeerConnection.instances[0].createdChannels.filter((channel) =>
          channel.name.includes("subscriber")
        )
      ).toHaveLength(1)
    )
    const channel = TestPeerConnection.instances[0].createdChannels.find(
      (candidate) => candidate.name.includes("subscriber")
    )!
    const createObjectUrl = vi.fn(() => "blob:file-1")
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    })

    vi.useFakeTimers()
    vi.setSystemTime(30_000)
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "message",
          message: {
            id: "text-1",
            peerId: "publisher-a",
            name: "publisher-a",
            kind: "human",
            type: "text",
            text: "later text",
            createdAt: 1,
            sequence: 1,
          },
        }),
      })
    )
    vi.setSystemTime(60_000)
    act(() =>
      channel.emit("message", {
        data: JSON.stringify({
          type: "file-start",
          id: "file-1",
          name: "first.txt",
          mime: "text/plain",
          size: 3,
          afterSequence: 0,
        }),
      })
    )
    act(() => {
      channel.emit("message", { data: new Uint8Array([1, 2, 3]).buffer })
      channel.emit("message", {
        data: JSON.stringify({ type: "file-end", id: "file-1" }),
      })
    })

    expect(result.current.messages.map((message) => message.messageId)).toEqual(
      ["file-1", "text-1"]
    )
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("orders queued files by actual transfer start around an intervening Room text", async () => {
    const { result, socket, pc, unmount } = await connect()
    const localChannel = pc.createdChannels.find(
      (channel) => channel.name === "files-human-local"
    )!
    const createObjectUrl = vi.fn((file: File) => `blob:${file.name}`)
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    })
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("file-a")
      .mockReturnValueOnce("file-b")
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    localChannel.bufferedAmount = 256 * 1024 + 1
    const fileA = {
      name: "a.txt",
      type: "text/plain",
      size: 1,
      slice: () => ({
        arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
      }),
    } as unknown as File
    const fileB = {
      name: "b.txt",
      type: "text/plain",
      size: 1,
      slice: () => ({
        arrayBuffer: () => Promise.resolve(new Uint8Array([2]).buffer),
      }),
    } as unknown as File

    const firstSend = result.current.sendFileMessage(fileA)
    await flushAsync()
    expect(localChannel.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "file-start",
        id: "file-a",
        name: "a.txt",
        mime: "text/plain",
        size: 1,
        afterSequence: 0,
      })
    )

    const secondSend = result.current.sendFileMessage(fileB)
    vi.setSystemTime(2000)
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "message",
          message: {
            id: "text-between",
            peerId: "human-other",
            name: "Other",
            kind: "human",
            type: "text",
            text: "between files",
            createdAt: 2000,
            sequence: 1,
          },
        }),
      })
    )

    vi.setSystemTime(3000)
    localChannel.bufferedAmount = 0
    await act(async () => {
      localChannel.emit("bufferedamountlow")
      await firstSend
      await secondSend
    })

    expect(
      localChannel.send.mock.calls
        .map(([data]) =>
          typeof data === "string" && data.includes('"type":"file-start"')
            ? JSON.parse(data)
            : undefined
        )
        .filter(Boolean)
        .map((message) => ({
          id: message.id,
          afterSequence: message.afterSequence,
        }))
    ).toEqual([
      { id: "file-a", afterSequence: 0 },
      { id: "file-b", afterSequence: 1 },
    ])
    expect(result.current.messages.map((message) => message.messageId)).toEqual(
      ["file-a", "text-between", "file-b"]
    )
    unmount()
  })
})
