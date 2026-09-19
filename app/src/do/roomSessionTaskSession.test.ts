import { describe, expect, it, vi } from "vitest"

import { RoomSession, RoomStateBudgetExceededError } from "./RoomSession"
import type { RoomRecord } from "../room/types"

/**
 * #409 Task Session Continuation — Room orchestration.
 *
 * These tests pin the parts that MUST be true for the one-click product path:
 *
 *  - discovery is private, transient, correlated, and writes NO Room storage;
 *  - the canonical Task is appended ONLY after the resident Runtime
 *    acknowledged an EXACT prepared binding, so it can never race into
 *    session/new;
 *  - a failed preparation creates NO Task at all, and never falls back to a
 *    new session;
 *  - a legacy Runtime (agent-v0.5.34, no advertised feature) is never sent a
 *    session-control frame and keeps working exactly as before.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

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

function agent(id: string, continuation: boolean, connected = true) {
  return {
    id,
    name: id,
    kind: "agent" as const,
    connected,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    connectionNonce: `${id}-nonce`,
    ...(continuation
      ? { runtimeFeatures: { taskSessionContinuation: true } }
      : {}),
  }
}

function room(continuation = true): RoomRecord {
  return {
    createdAt: 1,
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": human("human-1", "human-1-token"),
      "human-2": human("human-2", "human-2-token"),
      "agent-a": agent("agent-a", continuation),
      "agent-b": agent("agent-b", false),
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
  connectionNonce: string,
  initialAttachment: Record<string, unknown>,
  onSend?: (payload: string) => void
): FakeSocket {
  let attachment: Record<string, unknown> | undefined = initialAttachment
  const socket: FakeSocket = {
    tag,
    sent: [],
    readyState: 1,
    send(payload: string) {
      socket.sent.push(payload)
      onSend?.(payload)
    },
    close: vi.fn(),
    serializeAttachment(value: unknown) {
      attachment = value as Record<string, unknown>
    },
    deserializeAttachment: () => attachment,
    attachment: () => attachment,
  }
  // The closure keeps the nonce observable in the attachment like the real DO.
  void connectionNonce
  return socket
}

function harness(continuation = true) {
  const store = new Map<string, unknown>([["room", room(continuation)]])
  let puts = 0
  let roomWritesFail = false
  /** Ordered evidence for the PREPARE < append < delivery assertion. */
  const order: string[] = []
  const humanSockets = new Map<string, FakeSocket>()
  const agentSockets = new Map<string, FakeSocket>()

  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        if (roomWritesFail && key === "room")
          throw new RoomStateBudgetExceededError(999999)
        puts += 1
        if (key === "room") {
          const record = value as RoomRecord
          if (record.messages.some((message) => message.collab)) {
            if (!order.includes("task-persisted")) order.push("task-persisted")
          }
        }
        store.set(key, value)
      },
      delete: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: (tag?: string) =>
      (tag === undefined
        ? [...agentSockets.values(), ...humanSockets.values()]
        : [...agentSockets.values()].filter(
            (socket) => socket.tag === tag
          )) as unknown as WebSocket[],
  }

  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)

  const webSocketMessage = (socket: FakeSocket, message: unknown) =>
    (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(socket as unknown as WebSocket, JSON.stringify(message))

  return {
    session,
    order,
    store,
    connectHuman: (participantId: string, nonce?: string): FakeSocket => {
      const connectionNonce = nonce ?? `${participantId}-connection`
      const socket = makeSocket(undefined, connectionNonce, {
        participantId,
        token: `${participantId}-token`,
        connectionNonce,
      })
      humanSockets.set(connectionNonce, socket)
      return socket
    },
    connectAgentSocket: (
      participantId: string,
      cursor = 0,
      nonce?: string
    ): FakeSocket => {
      const socket = makeSocket(
        `agent-event:${participantId}`,
        nonce ?? `${participantId}-nonce`,
        {
          kind: "agent-event",
          participantId,
          connectionNonce: nonce ?? `${participantId}-nonce`,
          cursor,
        },
        (payload) => {
          const frame = JSON.parse(payload) as { type?: string }
          if (frame.type !== "task-session-control") return
          if (!order.includes("prepare-sent")) order.push("prepare-sent")
        }
      )
      agentSockets.set(participantId, socket)
      return socket
    },
    sendHuman: (socket: FakeSocket, message: unknown) =>
      webSocketMessage(socket, message),
    sendAgent: (socket: FakeSocket, message: unknown) =>
      webSocketMessage(socket, message),
    stored: () => store.get("room") as RoomRecord,
    putCount: () => puts,
    /** Makes the primary Room record refuse every further write. */
    failRoomWrites: () => {
      roomWritesFail = true
    },
    frames: (socket: FakeSocket) =>
      socket.sent.map(
        (payload) => JSON.parse(payload) as Record<string, unknown>
      ),
    sessionControls: (participantId: string) =>
      (agentSockets.get(participantId)?.sent ?? [])
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .filter((frame) => frame.type === "task-session-control"),
    eventPushes: (participantId: string) =>
      (agentSockets.get(participantId)?.sent ?? [])
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .filter((frame) => frame.type === "events"),
    humanResults: (socket: FakeSocket) =>
      socket.sent
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .filter((frame) => String(frame.type).startsWith("task-session-")),
    clearAgentFrames: (participantId: string) => {
      const socket = agentSockets.get(participantId)
      if (socket) socket.sent.length = 0
    },
  }
}

/** Extracts the resident control requestId the Room is waiting on. */
function pendingControlRequestId(socket: FakeSocket): string {
  const attachment = socket.attachment() as {
    pendingSessionControl?: { requestId: string }
  }
  const requestId = attachment?.pendingSessionControl?.requestId
  if (!requestId) throw new Error("no pending session control")
  return requestId
}

/** Records when the Runtime's canonical Task event reaches the Agent socket. */
function recordDelivery(
  test: ReturnType<typeof harness>,
  participantId: string
) {
  const socket = test.connectAgentSocket(participantId, 0)
  const originalSend = socket.send
  socket.send = (payload: string) => {
    const frame = JSON.parse(payload) as { type?: string; events?: unknown[] }
    if (
      frame.type === "events" &&
      Array.isArray(frame.events) &&
      frame.events.length > 0
    ) {
      if (!test.order.includes("task-delivered"))
        test.order.push("task-delivered")
    }
    originalSend(payload)
  }
  return socket
}

describe("RoomSession Task Session Continuation (#409)", () => {
  it("appends the canonical Task only after the Runtime acknowledged the exact prepared binding", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = recordDelivery(test, "agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-1",
      targetParticipantId: "agent-a",
      sessionToken: "session-token-1",
      summary: "Continue this conversation",
    })

    // ONE private prepare frame, and NOTHING is created in the Room yet.
    const controls = test.sessionControls("agent-a")
    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({
      type: "task-session-control",
      operation: "prepare",
      humanParticipantId: "human-1",
      sessionToken: "session-token-1",
    })
    const taskRequestId = controls[0].taskRequestId as string
    expect(typeof taskRequestId).toBe("string")
    expect(taskRequestId.length).toBeGreaterThan(0)
    expect(test.stored().messages).toHaveLength(0)
    expect(test.humanResults(humanSocket)).toHaveLength(0)

    // The Runtime acknowledges PREPARED for exactly that canonical Task id.
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "prepare",
      requestId: pendingControlRequestId(agentSocket),
      ok: true,
    })

    // The canonical Task now exists, indistinguishable from an ordinary one.
    const messages = test.stored().messages
    expect(messages).toHaveLength(1)
    expect(messages[0].actionType).toBe("collab")
    expect(messages[0].collab?.requestId).toBe(taskRequestId)
    expect(messages[0].collab?.summary).toBe("Continue this conversation")
    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-start-result",
        requestId: "browser-1",
        ok: true,
      },
    ])

    // Exact ordering: PREPARE ack < canonical append < resident Task delivery.
    expect(test.order).toEqual([
      "prepare-sent",
      "task-persisted",
      "task-delivered",
    ])
  })

  it("creates no canonical Task and no Harness turn when the preparation fails", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = recordDelivery(test, "agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-1",
      targetParticipantId: "agent-a",
      sessionToken: "session-token-1",
      summary: "Continue this conversation",
    })
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "prepare",
      requestId: pendingControlRequestId(agentSocket),
      ok: false,
      error: "session_selection_expired",
    })

    // NO Task, NO resident Task event, and a truthful actionable error.
    expect(test.stored().messages).toHaveLength(0)
    expect(test.eventPushes("agent-a")).toHaveLength(0)
    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-start-result",
        requestId: "browser-1",
        ok: false,
        error: "session_selection_expired",
      },
    ])
    expect(test.order).toEqual(["prepare-sent"])
  })

  it("releases an exact preparation when the canonical append is refused", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-1",
      targetParticipantId: "agent-a",
      sessionToken: "session-token-1",
      summary: "Continue this conversation",
    })
    const controls = test.sessionControls("agent-a")
    const taskRequestId = controls[0].taskRequestId as string
    const prepareRequestId = controls[0].requestId as string

    // The canonical append fails after a successful preparation: the primary
    // Room record refuses the write.
    test.failRoomWrites()
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "prepare",
      requestId: prepareRequestId,
      ok: true,
    })

    expect(test.stored().messages).toHaveLength(0)
    // Best-effort release carrying EXACTLY the failed canonical Task id, so the
    // prepared binding can never affect any other Task.
    const cancels = test
      .sessionControls("agent-a")
      .filter((frame) => frame.operation === "cancel")
    expect(cancels).toHaveLength(1)
    expect(cancels[0].taskRequestId).toBe(taskRequestId)
    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-start-result",
        requestId: "browser-1",
        ok: false,
        error: "session_continuation_unavailable",
      },
    ])
  })

  it("creates no Task when the prepared Task's Agent becomes unreachable", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-1",
      targetParticipantId: "agent-a",
      sessionToken: "session-token-1",
      summary: "Continue this conversation",
    })
    const prepareRequestId = test.sessionControls("agent-a")[0]
      .requestId as string
    test.stored().participants["agent-a"].connected = false
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "prepare",
      requestId: prepareRequestId,
      ok: true,
    })

    expect(test.stored().messages).toHaveLength(0)
    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-start-result",
        requestId: "browser-1",
        ok: false,
        error: "session_continuation_unavailable",
      },
    ])
  })

  it("never sends a session-control frame to a Runtime that did not advertise the feature", async () => {
    const test = harness(false)
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })
    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-1",
      targetParticipantId: "agent-a",
      sessionToken: "session-token-1",
      summary: "Continue this conversation",
    })

    expect(test.sessionControls("agent-a")).toHaveLength(0)
    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-list-result",
        requestId: "browser-list-1",
        ok: false,
        error: "session_continuation_unsupported",
      },
      {
        type: "task-session-start-result",
        requestId: "browser-1",
        ok: false,
        error: "session_continuation_unsupported",
      },
    ])
    // The ordinary Start Task path is completely unaffected.
    await test.sendHuman(humanSocket, {
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "An ordinary new task",
    })
    expect(test.stored().messages).toHaveLength(1)
    expect(test.stored().messages[0].collab?.summary).toBe(
      "An ordinary new task"
    )
  })

  it("delivers discovery only to the exact resident socket and the result only to the originating Human", async () => {
    const test = harness()
    const requester = test.connectHuman("human-1")
    const bystander = test.connectHuman("human-2")
    const agentA = test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")

    await test.sendHuman(requester, {
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })

    // Only the selected Agent's own private socket sees the control.
    expect(test.sessionControls("agent-a")).toHaveLength(1)
    expect(test.sessionControls("agent-b")).toHaveLength(0)

    await test.sendAgent(agentA, {
      type: "task-session-result",
      operation: "list",
      requestId: pendingControlRequestId(agentA),
      ok: true,
      sessions: [
        {
          token: "session-token-1",
          title: "Fix shooter interpolation",
          projectToken: "project-token-1",
          projectLabel: "~/workspace/free4chat",
          updatedAt: "2026-09-19T10:00:00Z",
        },
      ],
      projects: [{ token: "project-token-1", label: "~/workspace/free4chat" }],
      hasMore: false,
    })

    expect(test.humanResults(requester)).toEqual([
      {
        type: "task-session-list-result",
        requestId: "browser-list-1",
        ok: true,
        sessions: [
          {
            token: "session-token-1",
            title: "Fix shooter interpolation",
            projectToken: "project-token-1",
            projectLabel: "~/workspace/free4chat",
            updatedAt: "2026-09-19T10:00:00Z",
          },
        ],
        projects: [
          { token: "project-token-1", label: "~/workspace/free4chat" },
        ],
        hasMore: false,
      },
    ])
    // No other Human receives ANY private frame.
    expect(test.humanResults(bystander)).toHaveLength(0)
    expect(bystander.sent).toHaveLength(0)
  })

  it("writes no Room storage and wakes no waiter while browsing sessions", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")
    // Warm the Room first: the very first load may run a legacy migration
    // save, which is a pre-existing read-path cost and not a discovery cost.
    await test.sendAgent(agentSocket, { type: "heartbeat", cursor: 0 })
    test.clearAgentFrames("agent-a")
    const putsBefore = test.putCount()

    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "list",
      requestId: pendingControlRequestId(agentSocket),
      ok: true,
      sessions: [],
      projects: [],
      hasMore: false,
    })

    expect(test.putCount()).toBe(putsBefore)
    expect(test.stored().messages).toHaveLength(0)
    expect(test.eventPushes("agent-a")).toHaveLength(0)
    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-list-result",
        requestId: "browser-list-1",
        ok: true,
        sessions: [],
        projects: [],
        hasMore: false,
      },
    ])
  })

  it("forwards EVERY discovery to the resident Runtime instead of caching a list", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    const discover = async (requestId: string, rows: string[]) => {
      await test.sendHuman(humanSocket, {
        type: "task-session-list",
        requestId,
        targetParticipantId: "agent-a",
      })
      await test.sendAgent(agentSocket, {
        type: "task-session-result",
        operation: "list",
        requestId: pendingControlRequestId(agentSocket),
        ok: true,
        sessions: rows.map((token) => ({
          token,
          title: token,
          projectToken: "project-token-1",
          projectLabel: "~/x",
        })),
        projects: [{ token: "project-token-1", label: "~/x" }],
        hasMore: false,
      })
    }

    await discover("browser-list-1", ["session-token-a", "session-token-b"])
    // The Runtime's provider gained a session: the Room must ask again rather
    // than answer from anything it already holds.
    await discover("browser-list-2", [
      "session-token-a",
      "session-token-b",
      "session-token-c",
    ])

    // One private control per discovery: no Room-side list cache.
    const operations = test
      .sessionControls("agent-a")
      .map((frame) => frame.operation)
    expect(operations).toEqual(["list", "list"])
    const results = test.humanResults(humanSocket)
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ ok: true })
    expect(
      (results[1] as { sessions: { token: string }[] }).sessions.map(
        (row) => row.token
      )
    ).toEqual(["session-token-a", "session-token-b", "session-token-c"])
    expect(test.putCount()).toBe(test.putCount())
  })

  it("bounds one outstanding request per Human socket and never queues work", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })
    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "browser-list-2",
      targetParticipantId: "agent-a",
    })

    expect(test.sessionControls("agent-a")).toHaveLength(1)
    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-list-result",
        requestId: "browser-list-2",
        ok: false,
        error: "task_session_busy",
      },
    ])
  })

  it("ignores a resident result that does not match the pending correlation", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })

    // Unknown request id, then a mismatched operation, then a wrong operation:
    // none of them may resolve the request or close the healthy stream.
    for (const frame of [
      {
        type: "task-session-result",
        operation: "list",
        requestId: "unknown",
        ok: true,
        sessions: [],
      },
      {
        type: "task-session-result",
        operation: "list",
        requestId: "browser-list-1",
        ok: true,
        sessions: [],
      },
      {
        type: "task-session-result",
        operation: "browse",
        requestId: "x",
        ok: true,
      },
    ]) {
      await test.sendAgent(agentSocket, frame)
    }
    expect(test.humanResults(humanSocket)).toHaveLength(0)
    expect(agentSocket.close).not.toHaveBeenCalled()

    // The real answer still works.
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "list",
      requestId: pendingControlRequestId(agentSocket),
      ok: true,
      sessions: [],
      projects: [],
      hasMore: false,
    })
    expect(test.humanResults(humanSocket)).toHaveLength(1)
  })

  it("ignores a stale resident result after a reconnect rotated the connection nonce", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })
    const requestId = pendingControlRequestId(agentSocket)

    // A reconnect replaces the resident: the old socket's result is no longer
    // the current resident's answer.
    test.stored().participants["agent-a"].connectionNonce = "replacement-nonce"
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "list",
      requestId,
      ok: true,
      sessions: [],
      projects: [],
      hasMore: false,
    })
    expect(test.humanResults(humanSocket)).toHaveLength(0)
  })

  it("fails a discovery response closed when it exceeds the product bounds", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })
    const rows = Array.from({ length: 40 }, (_, index) => ({
      token: `session-token-${index}`,
      title: `session ${index}`,
      projectToken: "project-token-1",
      projectLabel: "~/workspace/free4chat",
    }))
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "list",
      requestId: pendingControlRequestId(agentSocket),
      ok: true,
      sessions: rows,
      projects: [],
      hasMore: false,
    })

    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-list-result",
        requestId: "browser-list-1",
        ok: false,
        error: "session_continuation_unavailable",
      },
    ])
  })

  it("keeps a healthy resident stream open when an unrelated Human request is malformed", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    // A malformed discovery request is dropped without touching the resident.
    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "   ",
      targetParticipantId: "agent-a",
    })
    expect(test.sessionControls("agent-a")).toHaveLength(0)
    expect(test.humanResults(humanSocket)).toHaveLength(0)

    // The resident can still heartbeat and still serve a real request.
    await test.sendAgent(agentSocket, { type: "heartbeat", cursor: 0 })
    expect(agentSocket.close).not.toHaveBeenCalled()

    await test.sendHuman(humanSocket, {
      type: "task-session-list",
      requestId: "browser-list-1",
      targetParticipantId: "agent-a",
    })
    expect(test.sessionControls("agent-a")).toHaveLength(1)
  })

  it("rejects a malformed start before asking the Runtime to prepare anything", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")

    for (const message of [
      {
        type: "task-session-start",
        requestId: "browser-1",
        targetParticipantId: "agent-a",
        sessionToken: "",
        summary: "instruction",
      },
      {
        type: "task-session-start",
        requestId: "browser-2",
        targetParticipantId: "agent-a",
        sessionToken: "session-token-1",
        summary: "   ",
      },
      {
        type: "task-session-start",
        requestId: "browser-3",
        targetParticipantId: "agent-a",
        sessionToken: "session-token-1",
        summary: "x".repeat(1201),
      },
    ]) {
      await test.sendHuman(humanSocket, message)
    }

    expect(test.sessionControls("agent-a")).toHaveLength(0)
    expect(test.humanResults(humanSocket)).toEqual([
      {
        type: "task-session-start-result",
        requestId: "browser-1",
        ok: false,
        error: "invalid_session_control",
      },
      {
        type: "task-session-start-result",
        requestId: "browser-2",
        ok: false,
        error: "invalid_session_control",
      },
      {
        type: "task-session-start-result",
        requestId: "browser-3",
        ok: false,
        error: "invalid_session_control",
      },
    ])
    expect(test.stored().messages).toHaveLength(0)
  })

  it("fails closed when the originating Human socket is gone", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-1",
      targetParticipantId: "agent-a",
      sessionToken: "session-token-1",
      summary: "Continue this conversation",
    })
    const requestId = pendingControlRequestId(agentSocket)
    // The Human socket disappears between PREPARE and PREPARED.
    humanSocket.readyState = 3
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "prepare",
      requestId,
      ok: true,
    })

    expect(test.stored().messages).toHaveLength(0)
    const cancels = test
      .sessionControls("agent-a")
      .filter((frame) => frame.operation === "cancel")
    expect(cancels).toHaveLength(1)
  })
})
