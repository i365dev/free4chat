import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useSfuChatRoom } from "./useSfuChatRoom"

/**
 * #363: a Human Task attachment must ride the existing bounded,
 * task-correlated Room attachment API (exact X-Task-Request-Id, 768 KB
 * Agent-readable bound) and never the 20 MB Human browser DataChannel
 * transfer. The compose-first composer also needs an initiation edge from the
 * ordinary Room file path so it never completes an obviously partial
 * submission.
 */

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

  constructor(
    public label = "",
    public options: Record<string, unknown> = {}
  ) {}

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
  addTransceiver(track: FakeTrack) {
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
  onmessage: ((event: { data: string }) => void) | null
} | null = null

describe("useSfuChatRoom task + compose-first attachments (#363)", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let attachmentResponse: () => Promise<Response>

  beforeEach(() => {
    FakePeerConnection.instances.length = 0
    FakePeerConnection.dataChannels.length = 0
    ;(global as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection
    class FakeMediaStream {
      constructor(private tracks: FakeTrack[] = []) {}
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
      constructor(_url: string) {
        lastFakeWebSocket = this
      }
      send() {}
      close() {}
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

    attachmentResponse = () =>
      jsonResponse({
        attachment: {
          id: "attachment-1",
          taskRequestId: "task-1",
        },
      })
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/sfu/session"))
        return jsonResponse({
          participantId: "participant-1",
          participantToken: "participant-token",
          sessionId: "session-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
      if (url.endsWith("/api/sfu/datachannels/establish"))
        return jsonResponse({})
      if (url.endsWith("/api/sfu/datachannels/new"))
        return jsonResponse({ dataChannels: [{ id: 1 }] })
      if (url.endsWith("/api/sfu/tracks"))
        return localTrackResponse(init) ?? jsonResponse({})
      if (url.endsWith("/api/room/attachments")) return attachmentResponse()
      return jsonResponse({})
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    lastFakeWebSocket = null
    vi.restoreAllMocks()
  })

  async function connect() {
    const hook = renderHook(() =>
      useSfuChatRoom("attachment-room", "Alice", "audio", {})
    )
    await waitFor(() => expect(lastFakeWebSocket).not.toBeNull())
    act(() => lastFakeWebSocket?.onopen?.())
    await waitFor(() =>
      expect(
        FakePeerConnection.dataChannels.some(
          (channel) => channel.label === "files-participant-1"
        )
      ).toBe(true)
    )
    return hook
  }

  function localFileChannel() {
    return FakePeerConnection.dataChannels.find(
      (channel) => channel.label === "files-participant-1"
    )!
  }

  function taskUploadCall() {
    return fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/room/attachments")
    ) as [string, RequestInit] | undefined
  }

  it("uploads a Task attachment through the bounded API with the exact task correlation", async () => {
    const { result } = await connect()
    const file = new File([new Uint8Array([1, 2, 3, 4])], "notes.md", {
      type: "text/markdown",
    })

    await act(async () => {
      await result.current.sendTaskAttachment(file, "task-1")
    })

    const upload = taskUploadCall()
    expect(upload).toBeDefined()
    const headers = upload![1].headers as Record<string, string>
    expect(headers["X-Task-Request-Id"]).toBe("task-1")
    expect(headers["X-Room-Id"]).toBe("attachment-room")
    expect(headers["X-Room-Participant-Id"]).toBe("participant-1")
    expect(headers["X-Room-Participant-Token"]).toBe("participant-token")
    expect(headers["Content-Type"]).toBe("text/markdown")
    expect(headers["X-File-Name"]).toBe(encodeURIComponent("notes.md"))
    expect(upload![1].method).toBe("POST")

    // The 20 MB Human browser transfer is never used for a Task attachment.
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("keeps the exact active Task id when the Task is no longer valid (fail closed)", async () => {
    const { result } = await connect()
    const file = new File([new Uint8Array([1, 2, 3, 4])], "notes.md", {
      type: "text/markdown",
    })
    attachmentResponse = () =>
      jsonResponse({ error: "unknown_task_request" }, 409)

    let caught: unknown
    await act(async () => {
      caught = await result.current
        .sendTaskAttachment(file, "task-stale")
        .catch((error: unknown) => error)
    })

    expect(String(caught)).toContain("no longer active")
    const upload = taskUploadCall()
    expect(
      (upload![1].headers as Record<string, string>)["X-Task-Request-Id"]
    ).toBe("task-stale")
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("never falls back to Room scope for a missing Task correlation", async () => {
    const { result } = await connect()
    const file = new File([new Uint8Array([1, 2, 3, 4])], "notes.md", {
      type: "text/markdown",
    })

    let caught: unknown
    await act(async () => {
      caught = await result.current
        .sendTaskAttachment(file, "   ")
        .catch((error: unknown) => error)
    })

    expect(String(caught)).toContain("no longer active")
    expect(taskUploadCall()).toBeUndefined()
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("enforces the existing bounded Agent-readable size for Task attachments", async () => {
    const { result } = await connect()
    const oversized = {
      name: "large.txt",
      type: "text/plain",
      size: 768 * 1024 + 1,
    } as unknown as File

    let caught: unknown
    await act(async () => {
      caught = await result.current
        .sendTaskAttachment(oversized, "task-1")
        .catch((error: unknown) => error)
    })

    expect(String(caught)).toContain("768 KB")
    expect(taskUploadCall()).toBeUndefined()
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("reports the Room file initiation edge and completes the existing transfer", async () => {
    const { result } = await connect()
    const channel = localFileChannel()
    const onInitiated = vi.fn()
    // jsdom's Blob lacks arrayBuffer(); model the file exactly like the
    // existing DataChannel transfer tests do.
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:small-file"),
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    })
    const file = {
      name: "small.txt",
      type: "text/plain",
      size: 4,
      slice: () => ({
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
      }),
    } as unknown as File

    await act(async () => {
      await result.current.sendFileMessage(file, onInitiated)
    })

    expect(onInitiated).toHaveBeenCalledTimes(1)
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"file-start"')
    )
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"file-end"')
    )
  })

  it("never reports initiation for a Room file that cannot begin", async () => {
    const { result } = await connect()
    const onInitiated = vi.fn()
    const oversized = {
      name: "huge.bin",
      type: "application/octet-stream",
      size: 21 * 1024 * 1024,
    } as unknown as File

    let caught: unknown
    await act(async () => {
      caught = await result.current
        .sendFileMessage(oversized, onInitiated)
        .catch((error: unknown) => error)
    })

    expect(String(caught)).toContain("20 MB")
    expect(onInitiated).not.toHaveBeenCalled()
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })
})
