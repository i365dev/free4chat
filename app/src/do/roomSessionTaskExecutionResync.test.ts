import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

/**
 * #421 execution reconciliation after Durable Object hibernation.
 *
 * Room execution projections are deliberately transient and MEMORY-ONLY. A
 * hibernated Durable Object therefore loses them while the resident Agent
 * WebSocket survives and the local Harness keeps working. Before this change
 * the Runtime only re-stated its execution truth when the RESIDENT stream
 * itself reconnected, so this legal lifecycle left a returning Human with no
 * truthful state at all:
 *
 *   Task Running -> Human disappears -> DO hibernates -> projections lost
 *   -> resident socket survives -> Human returns -> nothing is shown
 *
 * The fix is ONE on-demand reconciliation: a tiny private fire-and-forget
 * `task-execution-resync` frame, sent only to a resident that advertises
 * `taskExecutionReconciliation`. No polling, no timer, no persistence, and no
 * interaction with the #420 session-control correlation.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000
/** What a #422 Runtime advertises. */
const MODERN_FEATURES = {
  taskSessionContinuation: true,
  taskExecutionReconciliation: true,
}
/** agent-v0.5.34 advertises only Task Session Continuation. */
const LEGACY_FEATURES = { taskSessionContinuation: true }

interface FakeSocket {
  readonly tag?: string
  readonly sent: string[]
  readyState: number
  send: (payload: string) => void
  close: ReturnType<typeof vi.fn>
  serializeAttachment: (value: unknown) => void
  deserializeAttachment: () => unknown
  attachment: () => Record<string, unknown> | undefined
}

function human(id: string, token: string): RoomRecord["participants"][string] {
  return {
    id,
    name: id,
    kind: "human",
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token,
    media: {
      sessionId: `${id}-session`,
      muted: false,
      fileChannelReady: true,
      tracks: [{ trackName: "mic", kind: "audio" }],
    },
  }
}

function agent(
  id: string,
  runtimeFeatures: Record<string, boolean>
): RoomRecord["participants"][string] {
  return {
    id,
    name: id,
    kind: "agent" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    connectionNonce: `${id}-nonce`,
    runtimeFeatures,
  }
}

function room(features: Record<string, boolean>): RoomRecord {
  return {
    createdAt: 1,
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": human("human-1", "human-1-token"),
      "agent-a": agent("agent-a", features),
    },
    messages: [],
    nextMessageSequence: 0,
    attachments: [],
    nextTranscriptSequence: 0,
    nextLiveTranscriptEpoch: 1,
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

function makeSocket(
  tag: string | undefined,
  initialAttachment: Record<string, unknown>
): FakeSocket {
  let attachment: Record<string, unknown> | undefined = initialAttachment
  const socket: FakeSocket = {
    tag,
    sent: [],
    readyState: 1,
    send(payload: string) {
      socket.sent.push(payload)
    },
    close: vi.fn(),
    serializeAttachment(value: unknown) {
      attachment = value as Record<string, unknown>
    },
    deserializeAttachment: () => attachment,
    attachment: () => attachment,
  }
  return socket
}

/**
 * A Room harness whose storage, sockets and broadcast log OUTLIVE the
 * RoomSession object, so `hibernate()` can model a Durable Object losing all of
 * its in-memory state while the resident WebSocket keeps living.
 */
function harness(features: Record<string, boolean> = MODERN_FEATURES) {
  const store = new Map<string, unknown>([["room", room(features)]])
  const humanSockets = new Map<string, FakeSocket>()
  const agentSockets = new Map<string, FakeSocket>()
  let accepted: FakeSocket[] = []

  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value)
      },
      delete: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: (tag?: string) =>
      (tag === undefined
        ? [...agentSockets.values(), ...humanSockets.values(), ...accepted]
        : [...agentSockets.values()].filter(
            (socket) => socket.tag === tag
          )) as unknown as WebSocket[],
    acceptWebSocket: (socket: unknown) => {
      accepted.push(socket as FakeSocket)
    },
  }

  let session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  const agentSocket = makeSocket("agent-event:agent-a", {
    kind: "agent-event",
    participantId: "agent-a",
    connectionNonce: "agent-a-nonce",
    cursor: 0,
  })
  agentSockets.set("agent-a", agentSocket)
  const humanSocket = makeSocket(undefined, {
    participantId: "human-1",
    token: "human-1-token",
    connectionNonce: "human-1-connection",
  })
  humanSockets.set("human-1", humanSocket)

  const webSocketMessage = (socket: FakeSocket, message: unknown) =>
    (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(socket as unknown as WebSocket, JSON.stringify(message))

  return {
    get session() {
      return session
    },
    store,
    agentSocket,
    humanSocket,
    /**
     * Models a hibernation: a BRAND-NEW RoomSession over the SAME durable
     * storage and the SAME still-connected sockets. Every in-memory map —
     * including transientTaskExecutions — starts empty, exactly as after
     * Cloudflare evicts an idle Durable Object.
     */
    hibernate: () => {
      session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
    },
    sendHuman: (message: unknown, socket: FakeSocket = humanSocket) =>
      webSocketMessage(socket, message),
    sendAgent: (message: unknown) => webSocketMessage(agentSocket, message),
    stored: () => store.get("room") as RoomRecord,
    executions: () =>
      [
        ...(
          session as unknown as {
            transientTaskExecutions: Map<string, unknown>
          }
        ).transientTaskExecutions.values(),
      ] as {
        taskRequestId: string
        phase?: string
        queuedCount: number
        currentTurnSequence?: number
      }[],
    pendingSessionControl: () =>
      agentSocket.attachment()?.pendingSessionControl,
    humanFrames: (socket: FakeSocket = humanSocket) =>
      socket.sent.map(
        (payload) => JSON.parse(payload) as Record<string, unknown>
      ),
    /**
     * The PRIVATE frames the Room pushed down the resident socket. Ordinary
     * `events` pushes are the normal Room event stream and are not part of the
     * private control families under test here.
     */
    agentFrames: () =>
      agentSocket.sent
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .filter((frame) => frame.type !== "events"),
    resyncFrames: () =>
      agentSocket.sent
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .filter((frame) => frame.type === "task-execution-resync"),
    clearAgentFrames: () => {
      agentSocket.sent.length = 0
    },
    publishExecution: async (projection: Record<string, unknown>) => {
      const response = await session.fetch(
        new Request("https://room/control", {
          method: "POST",
          body: JSON.stringify({
            action: "agent-task-execution",
            participantId: "agent-a",
            token: "agent-a-token",
            projection,
          }),
        })
      )
      return response.status
    },
    /** Ordinary Room control activity: must never produce a private frame. */
    ordinaryRoomActivity: async () => {
      const response = await session.fetch(
        new Request("https://room/control", {
          method: "POST",
          body: JSON.stringify({
            action: "agent-activity",
            participantId: "agent-a",
            token: "agent-a-token",
            scopeId: "room",
            activity: "working",
            turnSequence: 1,
          }),
        })
      )
      return response.status
    },
    /**
     * The real Human WebSocket upgrade path. That is where a returning Human
     * triggers reconciliation, so the test must exercise it rather than the
     * message handler.
     */
    connectHuman: async () => {
      const server = makeSocket(undefined, {
        participantId: "human-1",
        token: "human-1-token",
        connectionNonce: "human-1-connection",
      })
      const pair = { 0: makeSocket(undefined, {}), 1: server }
      class WebSocketPairMock {
        0 = pair[0]
        1 = pair[1]
      }
      // The Response constructor rejects the 101 status the real platform
      // accepts for an upgrade, so mirror the production shape locally.
      const NativeResponse = globalThis.Response
      class UpgradeResponse extends NativeResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit) {
          if (init?.status === 101) {
            super(null, { status: 200 })
            Object.defineProperty(this, "status", { value: 101 })
            return
          }
          super(body, init)
        }
      }
      vi.stubGlobal("WebSocketPair", WebSocketPairMock)
      vi.stubGlobal("Response", UpgradeResponse)
      try {
        const response = await session.fetch(
          new Request(
            "https://room/?participantId=human-1&token=human-1-token",
            { headers: { Upgrade: "websocket" } }
          )
        )
        return response
      } finally {
        vi.unstubAllGlobals()
      }
    },
  }
}

async function createTask(test: ReturnType<typeof harness>): Promise<string> {
  await test.sendHuman({
    type: "collab-request",
    targetParticipantId: "agent-a",
    summary: "Run a long task",
  })
  const requestId = test.stored().messages[0]?.collab?.requestId
  if (!requestId) throw new Error("canonical Task request was not created")
  return requestId
}

describe("Room execution reconciliation after DO hibernation (#421)", () => {
  it("asks the current resident to re-state Running exactly once when a Human returns", async () => {
    const test = harness()
    const requestId = await createTask(test)
    expect(
      await test.publishExecution({
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "running",
        queuedCount: 0,
      })
    ).toBe(200)
    expect(test.executions()).toHaveLength(1)

    // The Durable Object is evicted: same storage, same resident socket, empty
    // in-memory projections. The resident never reconnected.
    test.hibernate()
    test.clearAgentFrames()
    expect(test.executions()).toEqual([])

    expect((await test.connectHuman()).status).toBe(101)

    // Exactly ONE private, payload-free reconciliation trigger.
    expect(test.resyncFrames()).toEqual([{ type: "task-execution-resync" }])

    // The Runtime answers by re-publishing its current truth, which the Room
    // ingests through its existing path.
    await test.publishExecution({
      taskRequestId: requestId,
      currentTurnSequence: 42,
      phase: "running",
      queuedCount: 0,
    })
    expect(test.executions()).toEqual([
      {
        agentParticipantId: "agent-a",
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "running",
        queuedCount: 0,
      },
    ])
  })

  it("restores a QUEUED projection just as truthfully", async () => {
    const test = harness()
    const requestId = await createTask(test)
    expect(
      await test.publishExecution({
        taskRequestId: requestId,
        phase: "queued",
        queuedCount: 2,
      })
    ).toBe(200)

    test.hibernate()
    test.clearAgentFrames()
    expect(test.executions()).toEqual([])

    await test.connectHuman()
    expect(test.resyncFrames()).toHaveLength(1)

    await test.publishExecution({
      taskRequestId: requestId,
      phase: "queued",
      queuedCount: 2,
    })
    expect(test.executions()).toEqual([
      {
        agentParticipantId: "agent-a",
        taskRequestId: requestId,
        phase: "queued",
        queuedCount: 2,
      },
    ])
  })

  it("never manufactures a Running projection for a completed Task", async () => {
    const test = harness()
    await createTask(test)

    // The Task settled while the Human was away: the canonical Room log is the
    // durable truth and the Runtime has nothing transient to re-state.
    test.hibernate()
    test.clearAgentFrames()

    await test.connectHuman()
    expect(test.resyncFrames()).toHaveLength(1)

    // The Runtime re-states nothing, so no phantom Running turn appears.
    expect(test.executions()).toEqual([])
    expect(test.stored().messages.length).toBeGreaterThan(0)
  })

  it("reconciles on an explicit Human resync too, and only on demand", async () => {
    const test = harness()
    await createTask(test)

    test.hibernate()
    test.clearAgentFrames()
    // Nothing happens without a Human action: no timer, no poll.
    expect(test.resyncFrames()).toEqual([])

    await test.sendHuman({ type: "resync" })
    expect(test.resyncFrames()).toEqual([{ type: "task-execution-resync" }])
  })

  it("never polls: repeated ordinary Room activity sends no private frame", async () => {
    const test = harness()
    await createTask(test)
    test.clearAgentFrames()

    for (let index = 0; index < 5; index += 1) {
      expect(await test.ordinaryRoomActivity()).toBe(200)
    }
    // A second explicit resync is still exactly ONE frame: on demand, never a
    // loop.
    await test.sendHuman({ type: "resync" })
    expect(test.resyncFrames()).toHaveLength(1)
  })

  it("sends NO resync frame to a legacy Runtime that does not advertise it", async () => {
    const test = harness(LEGACY_FEATURES)
    const requestId = await createTask(test)
    await test.publishExecution({
      taskRequestId: requestId,
      currentTurnSequence: 42,
      phase: "running",
      queuedCount: 0,
    })
    test.hibernate()
    test.clearAgentFrames()

    await test.connectHuman()
    await test.sendHuman({ type: "resync" })

    // An unknown private frame must never reach agent-v0.5.34.
    expect(test.resyncFrames()).toEqual([])
    expect(test.agentFrames()).toEqual([])
    // Ordinary Room/Task behavior is untouched.
    expect(await test.ordinaryRoomActivity()).toBe(200)
    expect(test.executions()).toEqual([])
  })

  it("keeps a live #420 session control byte-for-byte intact across a resync", async () => {
    const test = harness()
    await createTask(test)

    // Hold a real session-control correlation live on the resident socket.
    await test.sendHuman({
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })
    const pendingBefore = test.pendingSessionControl() as {
      requestId: string
    }
    expect(pendingBefore).toBeDefined()
    expect(test.agentFrames()).toEqual([
      {
        type: "task-session-control",
        operation: "list",
        requestId: pendingBefore.requestId,
        humanParticipantId: "human-1",
      },
    ])

    // Human return triggers reconciliation while that correlation is live.
    await test.connectHuman()
    await test.sendHuman({ type: "resync" })
    expect(test.resyncFrames()).toHaveLength(2)

    // The reconciliation frame is a SEPARATE family: the pending session
    // correlation is byte-for-byte unchanged.
    expect(test.pendingSessionControl()).toEqual(pendingBefore)

    // And its later result still routes to the waiting Human normally.
    await test.sendAgent({
      type: "task-session-result",
      operation: "list",
      requestId: pendingBefore.requestId,
      ok: true,
      sessions: [
        {
          token: "session-token-1",
          title: "Session A",
          projectToken: "project-token-1",
          projectLabel: "~/a",
        },
      ],
      projects: [{ token: "project-token-1", label: "~/a" }],
      hasMore: false,
    })
    const results = test
      .humanFrames()
      .filter((frame) => frame.type === "task-session-list-result")
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ requestId: "browser-list-1", ok: true })
  })
})
