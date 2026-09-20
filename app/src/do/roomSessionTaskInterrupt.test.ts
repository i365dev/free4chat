import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomMessage, RoomRecord } from "../room/types"

/**
 * #409 Task-scoped remote interrupt.
 *
 * These tests pin the Room-side contract: a transient control-plane action
 * that (a) resolves the canonical Task, (b) is authorized only for the Human
 * who created that Human→Agent Task, (c) is delivered only to that Task's
 * canonical Agent resident socket, and (d) never touches Room history.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

interface FakeSocket {
  readonly tag?: string
  readonly sent: string[]
  send: (payload: string) => void
  close: ReturnType<typeof vi.fn>
  serializeAttachment: ReturnType<typeof vi.fn>
  deserializeAttachment: () => unknown
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

function agent(id: string, connected = true) {
  return {
    id,
    name: id,
    kind: "agent" as const,
    connected,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    connectionNonce: `${id}-nonce`,
  }
}

function room(): RoomRecord {
  return {
    createdAt: 1,
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": human("human-1", "human-1-token"),
      "human-2": human("human-2", "human-2-token"),
      "agent-a": agent("agent-a"),
      "agent-b": agent("agent-b"),
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

function harness() {
  const store = new Map<string, unknown>([["room", room()]])
  let puts = 0
  const humanSocket = { send: vi.fn(), close: vi.fn() } as unknown as WebSocket
  const agentSockets = new Map<string, FakeSocket>()

  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        puts += 1
        store.set(key, value)
      },
      delete: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: (tag?: string) =>
      (tag === undefined
        ? [...agentSockets.values(), humanSocket]
        : [...agentSockets.values()].filter(
            (socket) => socket.tag === tag
          )) as unknown as WebSocket[],
  }

  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)

  const deliverHuman = (
    participantId: string,
    token: string,
    message: unknown
  ) =>
    (
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
        participantId,
        token,
        connectionNonce: `${participantId}-connection`,
      },
      message
    )

  return {
    session,
    humanSocket,
    store,
    /** Register the private resident socket an Agent would have connected. */
    connectAgentSocket: (participantId: string, cursor = 0): FakeSocket => {
      const socket: FakeSocket = {
        tag: `agent-event:${participantId}`,
        sent: [],
        send(payload: string) {
          socket.sent.push(payload)
        },
        close: vi.fn(),
        serializeAttachment: vi.fn(),
        deserializeAttachment: () => ({
          kind: "agent-event",
          participantId,
          connectionNonce: `${participantId}-nonce`,
          cursor,
        }),
      }
      agentSockets.set(participantId, socket)
      return socket
    },
    sendHuman: (message: unknown, participantId = "human-1") =>
      deliverHuman(participantId, `${participantId}-token`, message),
    stored: () => store.get("room") as RoomRecord,
    transientActivities: () =>
      [
        ...(
          session as unknown as {
            transientAgentActivities: Map<string, unknown>
          }
        ).transientAgentActivities.values(),
      ] as {
        agentParticipantId: string
        scopeId: string
        state: string
        turnSequence: number
      }[],
    putCount: () => puts,
    errorFrames: () =>
      (humanSocket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .filter((frame) => frame.type === "error")
        .map((frame) => frame.error),
    /** #421 Fix G: benign Task control outcomes are NOT error frames. */
    notices: () =>
      (humanSocket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .filter((frame) => frame.type === "task-control-notice")
        .map((frame) => frame.notice),
    /** Canonical Task instructions this Human appended, text only. */
    humanInstructions: (participantId = "human-1") =>
      (store.get("room") as RoomRecord).messages
        .filter(
          (message) =>
            message.peerId === participantId && message.type === "text"
        )
        .map((message) => message.text),
    /** Task control frames only: ordinary resident event pushes are separate. */
    agentControls: (participantId: string) =>
      (agentSockets.get(participantId)?.sent ?? [])
        .map((payload) => JSON.parse(payload))
        .filter((frame) => frame.type === "task-control"),
    clearAgentFrames: (participantId: string) => {
      const socket = agentSockets.get(participantId)
      if (socket) socket.sent.length = 0
    },
    /** Publish transient Agent activity through the real control action. */
    publishActivity: async (
      participantId: string,
      scopeId: string,
      state: string,
      turnSequence: number
    ) => {
      const response = await session.fetch(
        new Request("https://room/control", {
          method: "POST",
          body: JSON.stringify({
            action: "agent-activity",
            participantId,
            token: `${participantId}-token`,
            scopeId,
            activity: state,
            turnSequence,
          }),
        })
      )
      return {
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
      }
    },
    /**
     * #421 Fix C: publish the AUTHORITATIVE Task execution projection through
     * the real control action. This — not AgentActivity — is what authorizes an
     * exact-turn interrupt.
     */
    publishExecution: async (
      participantId: string,
      taskRequestId: string,
      projection: {
        currentTurnSequence?: number
        phase?: string
        queuedCount?: number
        lastOutcome?: string
        availability?: string
      }
    ) => {
      const response = await session.fetch(
        new Request("https://room/control", {
          method: "POST",
          body: JSON.stringify({
            action: "agent-task-execution",
            participantId,
            token: `${participantId}-token`,
            projection: {
              taskRequestId,
              queuedCount: projection.queuedCount ?? 0,
              ...(projection.currentTurnSequence === undefined
                ? {}
                : { currentTurnSequence: projection.currentTurnSequence }),
              ...(projection.phase === undefined
                ? {}
                : { phase: projection.phase }),
              ...(projection.lastOutcome === undefined
                ? {}
                : { lastOutcome: projection.lastOutcome }),
              ...(projection.availability === undefined
                ? {}
                : { availability: projection.availability }),
            },
          }),
        })
      )
      return {
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
      }
    },
    /** Clear a participant's transient execution projection, the way a
     * disconnect does. */
    clearExecutionsFor: (participantId: string) => {
      const executions = (
        session as unknown as {
          transientTaskExecutions: Map<string, { agentParticipantId: string }>
        }
      ).transientTaskExecutions
      for (const [key, execution] of executions)
        if (execution.agentParticipantId === participantId)
          executions.delete(key)
    },
    /** Clear a participant's presentation-only AgentActivity projection. */
    clearActivitiesFor: (participantId: string) => {
      const activities = (
        session as unknown as {
          transientAgentActivities: Map<string, { agentParticipantId: string }>
        }
      ).transientAgentActivities
      for (const [key, activity] of activities)
        if (activity.agentParticipantId === participantId)
          activities.delete(key)
    },
    control: async (body: Record<string, unknown>) => {
      const response = await session.fetch(
        new Request("https://room/control", {
          method: "POST",
          body: JSON.stringify(body),
        })
      )
      return {
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
      }
    },
  }
}

async function createTask(
  test: ReturnType<typeof harness>,
  targetParticipantId = "agent-a"
): Promise<string> {
  await test.sendHuman({
    type: "collab-request",
    targetParticipantId,
    summary: "Run a long task",
  })
  const message = test.stored().messages[0]
  const requestId = message.collab?.requestId
  if (!requestId) throw new Error("canonical Task request was not created")
  return requestId
}

describe("RoomSession Task interrupt (#409)", () => {
  it("delivers one transient control to the canonical Agent resident socket", async () => {
    const test = harness()
    const agentSocket = test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")
    const requestId = await createTask(test)
    const running = await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    expect(running.status).toBe(200)
    test.clearAgentFrames("agent-a")
    test.clearAgentFrames("agent-b")
    const putsBefore = test.putCount()

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
    // The other participating Agent never receives another Task's control.
    expect(test.agentControls("agent-b")).toEqual([])
    expect(test.errorFrames()).toEqual([])
    expect(agentSocket.close).not.toHaveBeenCalled()
    // A control is not conversation content: no Room write at all, not even a
    // participant lastSeen refresh.
    expect(test.putCount()).toBe(putsBefore)
  })

  it("appends no Room message, sequence, or timeline entry", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    const messagesBefore = JSON.parse(
      JSON.stringify(test.stored().messages)
    ) as RoomMessage[]
    const sequenceBefore = test.stored().nextMessageSequence
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    const sentBefore = (test.humanSocket.send as ReturnType<typeof vi.fn>).mock
      .calls.length

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.stored().messages).toEqual(messagesBefore)
    expect(test.stored().nextMessageSequence).toBe(sequenceBefore)
    expect(
      (test.humanSocket.send as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(sentBefore)
  })

  it("lets a current Human who did not create the Task interrupt its exact live turn", async () => {
    // #421 supervision is Room-shared once a canonical Task exists: the
    // original ephemeral creator is provenance, not a durable credential, and
    // it expires after the reconnect grace. A returning Human already may send
    // a follow-up and resolve the Task's permission, so requiring the creator
    // id here was internally inconsistent.
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    await test.sendHuman(
      { type: "task-interrupt", taskRequestId: requestId, turnSequence: 42 },
      "human-2"
    )

    expect(test.errorFrames()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
  })

  it("rejects an unknown or stale Task id", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    await createTask(test)
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: "task-that-does-not-exist",
      turnSequence: 42,
    })

    expect(test.errorFrames()).toEqual(["unknown_task_request"])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("rejects a malformed or oversized Task id before doing any work", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    await createTask(test)
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: 7,
      turnSequence: 42,
    })
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: "",
      turnSequence: 42,
    })
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: "t".repeat(65),
      turnSequence: 42,
    })

    expect(test.errorFrames()).toEqual([
      "invalid_task_request",
      "invalid_task_request",
      "invalid_task_request",
    ])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("rejects an interrupt when the canonical Agent has no resident socket", async () => {
    const test = harness()
    // agent-a is connected in Room state but holds no private resident socket.
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.errorFrames()).toEqual(["task_agent_not_reachable"])
  })

  it("rejects an interrupt when the canonical Agent is disconnected", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.stored().participants["agent-a"].connected = false

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.errorFrames()).toEqual(["task_target_not_in_room"])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("never lets the browser choose the target Agent", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    await test.publishActivity("agent-b", `task:${requestId}`, "working", 99)
    test.clearAgentFrames("agent-a")
    test.clearAgentFrames("agent-b")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
      // Every one of these is ignored: routing comes from the canonical Task.
      targetParticipantId: "agent-b",
      agentParticipantId: "agent-b",
      participantId: "agent-b",
      scopeId: "task:other",
    })

    expect(test.agentControls("agent-a")).toHaveLength(1)
    expect(test.agentControls("agent-b")).toEqual([])
  })

  it("reports a benign outcome for a turn that already finished", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    // The Task is running its turn 42.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    // A click delayed in transport still names the PREVIOUS turn.
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 41,
    })

    // #421 Fix G: a stale exact turn is a benign control race — a bounded,
    // human-readable outcome, never a raw protocol code in the Room-wide
    // failure banner.
    expect(test.errorFrames()).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("reports the same benign outcome for a Task with no running turn", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.errorFrames()).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("never treats a legacy activity without a turn as interrupt authority", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    // A pre-#414 Agent Runtime publishes activity with no exact turn. It is
    // still projected (the Human sees the Agent working) but it can never
    // authorize a control.
    const legacy = await test.control({
      action: "agent-activity",
      participantId: "agent-a",
      token: "agent-a-token",
      scopeId: `task:${requestId}`,
      activity: "working",
    })
    expect(legacy.status).toBe(200)
    expect(test.transientActivities()).toEqual([
      {
        agentParticipantId: "agent-a",
        scopeId: `task:${requestId}`,
        state: "working",
      },
    ])
    test.clearAgentFrames("agent-a")

    // A browser that guesses a turn is refused by the exact-turn gate, and a
    // request without one is refused before any lookup.
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    await test.sendHuman({ type: "task-interrupt", taskRequestId: requestId })

    // #421 Fix C: the activity is presentation only, so it can never name an
    // interrupt turn; the malformed request is still a hard protocol refusal.
    expect(test.errorFrames()).toEqual(["invalid_task_turn"])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("rejects an unusable turn sequence before touching the transport", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    for (const turnSequence of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "42",
      null,
      undefined,
    ]) {
      await test.sendHuman({
        type: "task-interrupt",
        taskRequestId: requestId,
        turnSequence,
      })
    }

    expect(test.errorFrames()).toEqual([
      "invalid_task_turn",
      "invalid_task_turn",
      "invalid_task_turn",
      "invalid_task_turn",
      "invalid_task_turn",
      "invalid_task_turn",
      "invalid_task_turn",
    ])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("carries the exact turn on every transient activity update", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    const scopeId = `task:${requestId}`

    for (const [state, sequence] of [
      ["working", 42],
      ["thinking", 42],
      ["using_tools", 42],
      ["responding", 42],
    ] as const) {
      const published = await test.publishActivity(
        "agent-a",
        scopeId,
        state,
        sequence
      )
      expect(published.status).toBe(200)
    }
    const broadcast = (
      test.humanSocket.send as ReturnType<typeof vi.fn>
    ).mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .filter((frame) => frame.type === "agentActivity" && frame.activity)
      .map((frame) => frame.activity)
    expect(broadcast).toEqual([
      {
        agentParticipantId: "agent-a",
        scopeId,
        state: "working",
        turnSequence: 42,
      },
      {
        agentParticipantId: "agent-a",
        scopeId,
        state: "thinking",
        turnSequence: 42,
      },
      {
        agentParticipantId: "agent-a",
        scopeId,
        state: "using_tools",
        turnSequence: 42,
      },
      {
        agentParticipantId: "agent-a",
        scopeId,
        state: "responding",
        turnSequence: 42,
      },
    ])

    // The next turn of the same Task replaces the projection with its own
    // exact turn, and a clear removes the identity entirely.
    await test.publishActivity("agent-a", scopeId, "working", 47)
    expect(test.transientActivities()).toEqual([
      {
        agentParticipantId: "agent-a",
        scopeId,
        state: "working",
        turnSequence: 47,
      },
    ])
    const cleared = await test.control({
      action: "agent-activity",
      participantId: "agent-a",
      token: "agent-a-token",
      scopeId,
      activity: null,
      turnSequence: 0,
    })
    expect(cleared.status).toBe(200)
    expect(test.transientActivities()).toEqual([])
  })

  it("rejects an explicitly malformed activity turn", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)

    // An ABSENT turnSequence is the legacy-compatible case (covered above);
    // these explicit values cannot identify a turn and must fail closed.
    for (const turnSequence of [0, -1, 1.5, "42", null]) {
      const published = await test.publishActivity(
        "agent-a",
        `task:${requestId}`,
        "working",
        turnSequence as number
      )
      expect(published.status).toBe(400)
      expect(published.json.error).toBe("invalid_activity_turn")
    }
  })

  it("accepts a current Human interrupt of a canonical Task regardless of its creator", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const stored = test.stored()
    stored.messages.push({
      id: "agent-owned-request",
      peerId: "agent-a",
      name: "agent-a",
      kind: "agent",
      type: "action",
      actionType: "collab",
      sequence: 1,
      createdAt: 1,
      collab: {
        requestId: "agent-owned-task",
        kind: "request",
        fromParticipantId: "agent-a",
        targetParticipantId: "human-1",
        summary: "Agent asks a Human",
      },
    })
    stored.nextMessageSequence = 1
    await test.publishExecution("agent-a", "agent-owned-task", {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: "agent-owned-task",
      turnSequence: 42,
    })

    // The canonical Task exists, its canonical Agent endpoint is reachable,
    // and 42 is its exact live turn, so a current Human may supervise it. The
    // origin participant kind is not an authorization input.
    expect(test.errorFrames()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: "agent-owned-task",
        turnSequence: 42,
      },
    ])
  })
})
