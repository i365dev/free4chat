import { afterEach, describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { CollabEvent, RoomRecord } from "../room/types"

/**
 * #346 terminal CollabOutcome depth.
 *
 * The canonical collaboration lifecycle (CollabRequested -> CollabOutcome)
 * already exists and is exactly-once. This suite pins ONLY the added coarse
 * product-value properties, and in particular the rule that they are derived
 * from the SAME canonical taskRequestId:
 *
 *   - durationBucket comes from the RETAINED canonical request message's
 *     createdAt, and is omitted (never fabricated, never persisted
 *     elsewhere) once the request falls outside the bounded message ring;
 *   - hasLiveView / hasGeneratedApp are exact Task correlation, so two
 *     concurrent Tasks can never contaminate one another;
 *   - hasArtifact keeps its existing semantics;
 *   - completed / failed / declined keep their existing semantics.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function human(id: string) {
  return {
    id,
    name: id,
    kind: "human" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    media: {
      sessionId: `${id}-session`,
      muted: false,
      fileChannelReady: true,
      tracks: [],
    },
  }
}

function agent(id: string) {
  return {
    id,
    name: id,
    kind: "agent" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    connectionNonce: `${id}-nonce`,
  }
}

function requestMessage(
  sequence: number,
  requestId: string,
  targetParticipantId: string,
  createdAt: number,
  summary = "bounded summary"
) {
  return {
    id: `msg-${sequence}`,
    peerId: "human-1",
    name: "human-1",
    kind: "human" as const,
    type: "action" as const,
    actionType: "collab",
    collab: {
      requestId,
      kind: "request" as const,
      fromParticipantId: "human-1",
      targetParticipantId,
      summary,
    },
    targets: [targetParticipantId],
    createdAt,
    sequence,
  }
}

function makeRoom(
  messages: RoomRecord["messages"] = [],
  attachments: RoomRecord["attachments"] = []
): RoomRecord {
  return {
    createdAt: 1,
    analyticsRoomId: crypto.randomUUID(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": human("human-1"),
      "agent-a": agent("agent-a"),
      "agent-b": agent("agent-b"),
    },
    messages,
    nextMessageSequence: messages.length,
    attachments,
    nextTranscriptSequence: 0,
    nextLiveTranscriptEpoch: 1,
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

function harness(storedRoom: RoomRecord = makeRoom()) {
  const store = new Map<string, unknown>([["room", storedRoom]])
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  const humanSocket = { send: vi.fn(), close: vi.fn() } as unknown as WebSocket
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
      },
      deleteAll: async () => void store.clear(),
      list: async (options: { prefix: string }) =>
        new Map(
          [...store.entries()].filter(([key]) => key.startsWith(options.prefix))
        ),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [humanSocket],
    waitUntil: (promise: Promise<unknown>) => void promise,
    id: { name: "test-room", toString: () => "test-room" },
  }
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} })
    if (String(url).includes("api.mixpanel.com"))
      return Promise.resolve(new Response("{}", { status: 200 }))
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  })
  vi.stubGlobal("fetch", fetchImpl)

  const session = new RoomSession(
    ctx as never,
    { SFU_ROOM: {}, MIXPANEL_PROJECT_TOKEN: "project-token" } as never
  )
  const internal = session as unknown as {
    loadRoom: () => Promise<RoomRecord | null>
    warmCollabRegistry: (room: RoomRecord) => void
    ingestCollabResponse: (
      room: RoomRecord,
      responder: RoomRecord["participants"][string],
      input: Record<string, unknown>
    ) => Promise<{ status: string; error?: string }>
  }
  const control = async (body: Record<string, unknown>) => {
    const response = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
    return {
      status: response.status,
      json: (await response.json()) as Record<string, any>,
    }
  }
  /** The ordinary browser Room-control socket this Human already holds. */
  const sendHuman = async (message: Record<string, unknown>) =>
    await (
      session as unknown as {
        handleClientMessage: (
          socket: WebSocket,
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      humanSocket,
      {
        participantId: "human-1",
        token: "human-1-token",
        connectionNonce: "human-1-connection",
      },
      message
    )
  return {
    session,
    internal,
    control,
    sendHuman,
    store,
    fetchCalls,
    stored: () => store.get("room") as RoomRecord,
  }
}

function outcomes(calls: Array<{ url: string; init: RequestInit }>) {
  return calls
    .filter((call) => call.url.includes("api.mixpanel.com"))
    .map((call) => JSON.parse(call.init.body as string))
    .flat()
    .filter((row: { event: string }) => row.event === "CollabOutcome")
    .map((row: { properties: Record<string, unknown> }) => row.properties)
}

function liveViewSurface(taskRequestId: string) {
  return {
    taskRequestId,
    surfaceId: "counter",
    authorityAgentId: "client-supplied-but-overwritten",
    revision: 1,
    root: {
      type: "Card",
      children: [{ type: "Text", text: "Count" }],
    },
    data: { count: 0 },
  }
}

function generatedBundle() {
  return {
    version: 1,
    manifest: { title: "Task App", networkOrigins: [] },
    html: "<main>app</main>",
    css: "main { font: 16px sans-serif; }",
    js: "document.body.dataset.ready = '1'",
    initialState: { items: [] },
  }
}

describe("CollabOutcome durationBucket (#346)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("buckets the canonical request-to-outcome span and never sends raw time", async () => {
    const fourMinutesAgo = Date.now() - 4 * 60_000
    const test = harness(
      makeRoom([requestMessage(1, "task-old", "agent-a", fourMinutesAgo)])
    )
    const room = await test.internal.loadRoom()
    expect(room).not.toBeNull()
    const result = await test.internal.ingestCollabResponse(
      room as RoomRecord,
      (room as RoomRecord).participants["agent-a"],
      { requestId: "task-old", kind: "completed" }
    )
    expect(result.status).toBe("recorded")

    const properties = outcomes(test.fetchCalls)
    expect(properties).toHaveLength(1)
    expect(properties[0].durationBucket).toBe("1-5m")
    expect(properties[0].outcome).toBe("completed")
    const serialized = JSON.stringify(properties[0])
    expect(serialized).not.toContain("task-old")
    expect(serialized).not.toContain("durationMs")
    expect(serialized).not.toContain("createdAt")
  })

  it("omits durationBucket when the request fell outside the bounded message ring", async () => {
    const test = harness(makeRoom())
    const room = (await test.internal.loadRoom()) as RoomRecord
    // Warm the registry while the request is still retained...
    room.messages = [
      requestMessage(1, "task-evicted", "agent-a", Date.now() - 90 * 60_000),
    ]
    room.nextMessageSequence = 1
    test.internal.warmCollabRegistry(room)
    // ...then let the bounded ring evict it, exactly as a very long Task
    // would. No analytics-only timing state exists to fall back on.
    room.messages = room.messages.filter((message) => message.sequence !== 1)

    const result = await test.internal.ingestCollabResponse(
      room,
      room.participants["agent-a"],
      { requestId: "task-evicted", kind: "completed" }
    )
    expect(result.status).toBe("recorded")

    const properties = outcomes(test.fetchCalls)
    expect(properties).toHaveLength(1)
    // Missing data is preferable to architectural pollution: the property is
    // simply absent, and the outcome is still complete.
    expect(properties[0]).not.toHaveProperty("durationBucket")
    expect(properties[0].outcome).toBe("completed")
    expect(properties[0].hasArtifact).toBe(false)
  })

  it("keeps declined and failed outcomes on the same exactly-once path", async () => {
    const failedAttachment = {
      id: "att-1",
      senderId: "agent-b",
      senderName: "agent-b",
      senderKind: "agent" as const,
      fileName: "result.txt",
      mimeType: "text/plain" as const,
      size: 12,
      chunkCount: 1,
      createdAt: Date.now(),
      sequence: 0,
      taskRequestId: "task-failed",
    }
    const test = harness(
      makeRoom(
        [
          requestMessage(1, "task-declined", "agent-a", Date.now() - 30_000),
          requestMessage(2, "task-failed", "agent-b", Date.now() - 120_000),
        ],
        [failedAttachment]
      )
    )
    const room = (await test.internal.loadRoom()) as RoomRecord
    await test.internal.ingestCollabResponse(
      room,
      room.participants["agent-a"],
      { requestId: "task-declined", kind: "declined" }
    )
    const failed = await test.internal.ingestCollabResponse(
      room,
      room.participants["agent-b"],
      { requestId: "task-failed", kind: "failed", attachmentIds: ["att-1"] }
    )
    expect(failed).toMatchObject({ status: "recorded" })
    // A retried identical decision is deduplicated by the canonical
    // registry, so it can never produce a second outcome event.
    const replay = await test.internal.ingestCollabResponse(
      room,
      room.participants["agent-a"],
      { requestId: "task-declined", kind: "declined" }
    )
    expect(replay.status).toBe("duplicate")

    const properties = outcomes(test.fetchCalls)
    expect(properties).toHaveLength(2)
    const byOutcome = Object.fromEntries(
      properties.map((entry) => [entry.outcome, entry])
    )
    expect(byOutcome.declined.durationBucket).toBe("<1m")
    expect(byOutcome.failed.durationBucket).toBe("1-5m")
    // hasArtifact keeps its existing semantics.
    expect(byOutcome.declined.hasArtifact).toBe(false)
    expect(byOutcome.failed.hasArtifact).toBe(true)
  })
})

describe("CollabOutcome Task-correlated output flags (#346)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("never lets concurrent Task B contaminate Task A's Live View or App flags", async () => {
    const test = harness()
    // Two concurrent Human->Agent Tasks in the same Room, each with its own
    // canonical executor.
    await test.sendHuman({
      type: "collab-request",
      requestId: "task-a",
      targetParticipantId: "agent-a",
      summary: "Task A",
    })
    await test.sendHuman({
      type: "collab-request",
      requestId: "task-b",
      targetParticipantId: "agent-b",
      summary: "Task B",
    })
    const requestIds = test
      .stored()
      .messages.map((message) => message.collab?.requestId)
    expect(requestIds).toEqual(["task-a", "task-b"])

    // Only Task B publishes a Live View and a generated App.
    const liveView = await test.control({
      action: "agent-publish-live-view",
      participantId: "agent-b",
      token: "agent-b-token",
      taskRequestId: "task-b",
      surface: liveViewSurface("task-b"),
    })
    expect(liveView.status).toBe(200)
    const generatedApp = await test.control({
      action: "agent-publish-generated-app",
      participantId: "agent-b",
      token: "agent-b-token",
      taskRequestId: "task-b",
      bundle: generatedBundle(),
    })
    expect(generatedApp.status).toBe(200)

    // Task A terminates first and must report NO output of its own.
    const completedA = await test.control({
      action: "agent-send-collab",
      participantId: "agent-a",
      token: "agent-a-token",
      event: { kind: "completed", requestId: "task-a", summary: "plain text" },
    })
    expect(completedA.status).toBe(200)
    // Then Task B terminates with both outputs.
    const completedB = await test.control({
      action: "agent-send-collab",
      participantId: "agent-b",
      token: "agent-b-token",
      event: { kind: "completed", requestId: "task-b", summary: "app result" },
    })
    expect(completedB.status).toBe(200)

    const properties = outcomes(test.fetchCalls)
    expect(properties).toHaveLength(2)
    const [taskA, taskB] = properties
    expect(taskA.hasLiveView).toBe(false)
    expect(taskA.hasGeneratedApp).toBe(false)
    expect(taskB.hasLiveView).toBe(true)
    expect(taskB.hasGeneratedApp).toBe(true)
    // Exact correlation only: no surface id, app instance id, title, source,
    // App state, request id, or result text ever rides.
    const serialized = JSON.stringify(properties)
    expect(serialized).not.toContain("task-a")
    expect(serialized).not.toContain("task-b")
    expect(serialized).not.toContain("counter")
    expect(serialized).not.toContain("generated:")
    expect(serialized).not.toContain("Task App")
    expect(serialized).not.toContain("result")
    expect(
      Object.keys(taskB)
        .filter(
          (key) => !["time", "distinct_id", "$insert_id", "ip"].includes(key)
        )
        .sort()
    ).toEqual(
      [
        "analyticsRoomId",
        "durationBucket",
        "hasArtifact",
        "hasGeneratedApp",
        "hasLiveView",
        "outcome",
        "requesterKind",
        "roomComposition",
        "roomHash",
        "roomType",
        "targetKind",
      ].sort()
    )
  })

  it("keeps the exact canonical envelope shape the analytics path consumes", async () => {
    const test = harness()
    await test.sendHuman({
      type: "collab-request",
      requestId: "task-only",
      targetParticipantId: "agent-a",
      summary: "Task",
    })
    const room = test.stored()
    const request = room.messages.find(
      (message) => message.collab?.requestId === "task-only"
    )?.collab as CollabEvent
    // The analytics path never invents its own correlation: it reads the
    // canonical request id the Room already persisted.
    expect(request.kind).toBe("request")
    expect(typeof request.requestId).toBe("string")
  })
})
