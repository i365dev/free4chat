import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useSfuChatRoom } from "./useSfuChatRoom"
import type { SfuRoomState } from "../sfu/types"

/**
 * #363: a Human Task attachment must ride the existing bounded,
 * task-correlated Room attachment API (exact X-Task-Request-Id, 768 KB
 * Agent-readable bound) and never the 20 MB Human browser DataChannel
 * transfer. The compose-first composer also needs a readiness edge from the
 * ordinary Room file path so it never completes an obviously partial
 * submission — and, when a bounded Agent-readable copy applies, that copy is
 * published before the text half is released (review point 1).
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

type StateParticipant = SfuRoomState["participants"][number]

function humanParticipant(
  id: string,
  fileChannelReady = true
): StateParticipant {
  return {
    id,
    name: id,
    kind: "human",
    connected: true,
    joinedAt: 0,
    lastSeenAt: 0,
    media: {
      sessionId: `publisher-${id}`,
      muted: false,
      fileChannelReady,
      tracks: [],
    },
  }
}

function agentParticipant(id: string): StateParticipant {
  return {
    id,
    name: id,
    kind: "agent",
    connected: true,
    joinedAt: 0,
    lastSeenAt: 0,
  }
}

function roomState(participants: StateParticipant[]): SfuRoomState {
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

/** A minimal File stand-in: jsdom's Blob has no arrayBuffer(), so the
 * DataChannel chunk loop models slice() exactly like the existing transfer
 * tests do. */
function fakeFile(options: { name: string; type: string; size: number }): File {
  const bytes = new Uint8Array(Math.min(options.size, 4))
  return {
    name: options.name,
    type: options.type,
    size: options.size,
    slice: () => ({
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    }),
  } as unknown as File
}

function stubObjectUrls() {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:file"),
  })
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  })
}

/** Model the existing Agent vision copy: a large source image is decoded and
 * re-encoded down to a bounded JPEG copy. */
function stubVisionCopy(options: {
  width: number
  height: number
  bytes: number
}) {
  class FakeImage {
    naturalWidth = 0
    naturalHeight = 0
    src = ""
    decode = () => {
      this.naturalWidth = options.width
      this.naturalHeight = options.height
      return Promise.resolve()
    }
  }
  vi.stubGlobal("Image", FakeImage)
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback: BlobCallback) => {
      callback({
        size: options.bytes,
        type: "image/jpeg",
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(options.bytes)),
      } as unknown as Blob)
    }
  )
}

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
    vi.unstubAllGlobals()
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
    return attachmentUploadCalls()[0]
  }

  function attachmentUploadCalls() {
    return fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/room/attachments")
    ) as Array<[string, RequestInit]>
  }

  it("uploads a Task attachment through the bounded API with the exact task correlation", async () => {
    const { result } = await connect()
    const file = new File([new Uint8Array([1, 2, 3, 4])], "notes.md", {
      type: "text/markdown",
    })

    await act(async () => {
      await result.current.sendTaskAttachment(file, "task-1", true)
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
    // Attachment-only Task submission: the persisted wake intent addresses
    // the participating Task Agent.
    expect(headers["X-Task-Attachment-Wake"]).toBe("1")
    expect(upload![1].method).toBe("POST")

    // The 20 MB Human browser transfer is never used for a Task attachment.
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("carries the composer's context-only intent for an attachment + text submission", async () => {
    const { result } = await connect()
    const file = new File([new Uint8Array([1, 2, 3, 4])], "notes.md", {
      type: "text/markdown",
    })

    await act(async () => {
      await result.current.sendTaskAttachment(file, "task-1", false)
    })

    // The following Task text is the single wake boundary; the attachment is
    // persisted as Task context and must not wake the Agent on its own.
    const headers = taskUploadCall()![1].headers as Record<string, string>
    expect(headers["X-Task-Request-Id"]).toBe("task-1")
    expect(headers["X-Task-Attachment-Wake"]).toBe("0")
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
        .sendTaskAttachment(file, "task-stale", false)
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
        .sendTaskAttachment(file, "   ", false)
        .catch((error: unknown) => error)
    })

    expect(String(caught)).toContain("no longer active")
    expect(taskUploadCall()).toBeUndefined()
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("keeps the raw 768 KB bound for a text-like Task attachment (#363 point 2)", async () => {
    const { result } = await connect()
    const oversized = fakeFile({
      name: "large.txt",
      type: "text/plain",
      size: 768 * 1024 + 1,
    })

    let caught: unknown
    await act(async () => {
      caught = await result.current
        .sendTaskAttachment(oversized, "task-1", false)
        .catch((error: unknown) => error)
    })

    expect(String(caught)).toContain("768 KB")
    expect(taskUploadCall()).toBeUndefined()
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("reports the Room file readiness edge and completes the existing transfer", async () => {
    const { result } = await connect()
    const channel = localFileChannel()
    const onReadiness = vi.fn()
    stubObjectUrls()
    const file = fakeFile({
      name: "small.bin",
      type: "application/zip",
      size: 4,
    })

    await act(async () => {
      await result.current.sendFileMessage(file, { onReadiness })
    })

    expect(onReadiness).toHaveBeenCalledTimes(1)
    expect(onReadiness.mock.calls[0][0]).toBeUndefined()
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"file-start"')
    )
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"file-end"')
    )
  })

  it("never releases a Room file that cannot begin", async () => {
    const { result } = await connect()
    const onReadiness = vi.fn()
    const oversized = fakeFile({
      name: "huge.bin",
      type: "application/octet-stream",
      size: 21 * 1024 * 1024,
    })

    let caught: unknown
    await act(async () => {
      caught = await result.current
        .sendFileMessage(oversized, { onReadiness })
        .catch((error: unknown) => error)
    })

    expect(String(caught)).toContain("20 MB")
    expect(onReadiness).not.toHaveBeenCalled()
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("accepts a multi-MB Task image and uploads the bounded derived copy", async () => {
    const { result } = await connect()
    stubVisionCopy({ width: 4000, height: 3000, bytes: 512 * 1024 })
    const file = fakeFile({
      name: "screenshot.png",
      type: "image/png",
      size: 4 * 1024 * 1024,
    })

    await act(async () => {
      await result.current.sendTaskAttachment(file, "task-1", false)
    })

    // The larger-than-768-KB source is accepted, and the DERIVED uploaded
    // copy — not the source — carries the Agent-readable bound.
    const upload = taskUploadCall()
    expect(upload).toBeDefined()
    const headers = upload[1].headers as Record<string, string>
    expect(headers["X-Task-Request-Id"]).toBe("task-1")
    expect(headers["Content-Type"]).toBe("image/jpeg")
    const uploaded = upload[1].body as ArrayBuffer
    expect(uploaded.byteLength).toBeLessThanOrEqual(768 * 1024)
    expect(uploaded.byteLength).toBeLessThan(file.size)
    // A Task attachment never rides the 20 MB DataChannel transfer.
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })

  it("fails closed when a Task image cannot produce a bounded copy", async () => {
    const { result } = await connect()
    // The existing vision path cannot re-encode this source under the
    // Agent-readable bound, so the derived-copy bound still fails closed.
    stubVisionCopy({ width: 4000, height: 3000, bytes: 768 * 1024 + 1 })
    const file = fakeFile({
      name: "screenshot.png",
      type: "image/png",
      size: 9 * 1024 * 1024,
    })

    let caught: unknown
    await act(async () => {
      caught = await result.current
        .sendTaskAttachment(file, "task-1", true)
        .catch((error: unknown) => error)
    })

    expect(caught).toBeInstanceOf(Error)
    expect(taskUploadCall()).toBeUndefined()
    expect(localFileChannel().send).not.toHaveBeenCalled()
  })
})

describe("Room file release edge (#363 review point 1)", () => {
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
      jsonResponse({ attachment: { id: "attachment-1" } })
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
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function connectWithAgent() {
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
    act(() =>
      lastFakeWebSocket?.onmessage?.({
        data: JSON.stringify({
          type: "state",
          state: roomState([
            humanParticipant("participant-1"),
            agentParticipant("agent-remote"),
          ]),
        }),
      })
    )
    await waitFor(() =>
      expect(
        hook.result.current.participants.some(
          (participant) => participant.kind === "agent"
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

  function attachmentUploadCalls() {
    return fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/room/attachments")
    ) as Array<[string, RequestInit]>
  }

  it("holds the release edge until the bounded Agent-readable copy is published", async () => {
    const { result } = await connectWithAgent()
    const channel = localFileChannel()
    stubObjectUrls()
    let settleCopy: ((response: Response) => void) | undefined
    attachmentResponse = () =>
      new Promise<Response>((resolve) => {
        settleCopy = resolve
      })
    const onReadiness = vi.fn()
    const file = fakeFile({ name: "notes.txt", type: "text/plain", size: 32 })

    await act(async () => {
      await result.current.sendFileMessage(file, { onReadiness })
    })

    // The whole Human DataChannel transfer already ran...
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"file-end"')
    )
    // ...and the bounded copy is still unpublished, so the text half of the
    // submission is deliberately NOT released yet.
    expect(onReadiness).not.toHaveBeenCalled()
    const uploads = attachmentUploadCalls()
    expect(uploads).toHaveLength(1)

    await act(async () => {
      settleCopy?.(await jsonResponse({ attachment: { id: "copy-1" } }))
    })
    await waitFor(() => expect(onReadiness).toHaveBeenCalledTimes(1))
    expect(onReadiness.mock.calls[0][0]).toBeUndefined()
  })

  it("does not gate a file with no bounded Agent-readable copy", async () => {
    const { result } = await connectWithAgent()
    const channel = localFileChannel()
    stubObjectUrls()
    const onReadiness = vi.fn()
    // The file is unsupported for Agent vision and too large for the bounded
    // text copy, so today's initiation edge is preserved.
    const file = fakeFile({
      name: "archive.zip",
      type: "application/zip",
      size: 2 * 1024 * 1024,
    })

    await act(async () => {
      await result.current.sendFileMessage(file, { onReadiness })
    })

    expect(onReadiness).toHaveBeenCalledTimes(1)
    expect(onReadiness.mock.calls[0][0]).toBeUndefined()
    // Released at local initiation, strictly before the transfer finished.
    const endIndex = channel.send.mock.calls.findIndex(
      ([data]) => typeof data === "string" && data.includes('"type":"file-end"')
    )
    expect(onReadiness.mock.invocationCallOrder[0]).toBeLessThan(
      channel.send.mock.invocationCallOrder[endIndex]
    )
    expect(attachmentUploadCalls()).toHaveLength(0)
  })

  it("reports a failed bounded copy instead of releasing the submission", async () => {
    const { result } = await connectWithAgent()
    const channel = localFileChannel()
    stubObjectUrls()
    attachmentResponse = () =>
      jsonResponse({ error: "attachment_too_large" }, 413)
    const onReadiness = vi.fn()
    const file = fakeFile({ name: "notes.txt", type: "text/plain", size: 32 })

    await act(async () => {
      await result.current.sendFileMessage(file, { onReadiness })
    })

    expect(onReadiness).toHaveBeenCalledTimes(1)
    expect(onReadiness.mock.calls[0][0]).toBeInstanceOf(Error)
    // The non-transactional Human transfer is never aborted by the secondary
    // Agent-readable copy failure.
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"file-end"')
    )
  })

  it("keeps the Room image path on the same bounded vision copy", async () => {
    const { result } = await connectWithAgent()
    stubObjectUrls()
    stubVisionCopy({ width: 4000, height: 3000, bytes: 320 * 1024 })
    const onReadiness = vi.fn()
    const file = fakeFile({
      name: "shot.png",
      type: "image/png",
      size: 3 * 1024 * 1024,
    })

    await act(async () => {
      await result.current.sendFileMessage(file, { onReadiness })
    })
    await waitFor(() => expect(onReadiness).toHaveBeenCalledTimes(1))
    expect(onReadiness.mock.calls[0][0]).toBeUndefined()

    const uploads = attachmentUploadCalls()
    expect(uploads).toHaveLength(1)
    const headers = uploads[0][1].headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("image/jpeg")
    const uploaded = uploads[0][1].body as ArrayBuffer
    expect(uploaded.byteLength).toBeLessThanOrEqual(768 * 1024)
    expect(uploaded.byteLength).toBeLessThan(file.size)
  })
})
