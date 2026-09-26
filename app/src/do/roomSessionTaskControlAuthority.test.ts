import { describe, expect, it, vi } from "vitest"

import { MAX_ATTACHMENT_ACTIVE_TASK_TURNS, RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

/**
 * #421 Fix C/D/G — Task execution must be the CONTROL AUTHORITY.
 *
 * The production dogfood failure this file pins down:
 *
 *   Task running -> Human leaves the Room -> the Durable Object hibernates ->
 *   the local Harness keeps working -> the Human returns -> the Room
 *   reconciliation restores the authoritative Task execution projection ->
 *   the UI shows "Running" and offers Interrupt -> clicking it produced
 *   `task_turn_not_active`.
 *
 * Structural cause: TaskExecutionProjection and AgentActivity are two separate
 * transient representations, fed by two separate Runtime requests. The
 * reconciliation path restores EXECUTION only, while interrupt authorization
 * read the presentation-only ACTIVITY map. Two truths, one of them empty.
 *
 * Required invariant, exercised below:
 *
 *   TaskExecutionProjection = authoritative Task execution/control state
 *   AgentActivity           = presentation detail only
 *
 * The inverse must hold too: a stale AgentActivity can never invent control
 * authority for a Task whose execution projection reports no active turn, and
 * a stale exact-turn request can never cancel a LATER turn.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

interface FakeSocket {
  readonly tag?: string
  readonly sent: string[]
  /** The hibernation-durable attachment, as Cloudflare keeps it. */
  attachment: Record<string, unknown>
  send: (payload: string) => void
  close: ReturnType<typeof vi.fn>
  serializeAttachment: (value: unknown) => void
  deserializeAttachment: () => unknown
}

function human(id: string): RoomRecord["participants"][string] {
  return {
    id,
    name: id,
    kind: "human",
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    media: {
      sessionId: `${id}-session`,
      muted: false,
      fileChannelReady: true,
      tracks: [{ trackName: "mic", kind: "audio" }],
    },
  }
}

function agent(id: string): RoomRecord["participants"][string] {
  return {
    id,
    name: id,
    kind: "agent" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    connectionNonce: `${id}-nonce`,
    runtimeFeatures: {
      taskSessionContinuation: true,
      taskExecutionReconciliation: true,
    },
  }
}

function room(): RoomRecord {
  return {
    createdAt: 1,
    analyticsRoomId: crypto.randomUUID(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": human("human-1"),
      "human-2": human("human-2"),
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
  const humanSocket = { send: vi.fn(), close: vi.fn() } as unknown as WebSocket
  // Every socket the Room owns per participant. The nonce-fence regression
  // deliberately keeps a replaced socket registered.
  const agentSockets = new Map<string, FakeSocket[]>()

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
    getWebSockets: (tag?: string) => {
      const sockets = [...agentSockets.values()].flat()
      return (tag === undefined
        ? [...sockets, humanSocket]
        : sockets.filter(
            (socket) => socket.tag === tag
          )) as unknown as WebSocket[]
    },
  }

  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)

  const frames = () =>
    (humanSocket.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      JSON.parse(call[0] as string)
    )

  const participantSockets = (participantId: string) =>
    agentSockets.get(participantId) ?? []

  const parsedAgentFrames = (participantId: string) =>
    participantSockets(participantId)
      .flatMap((socket) => socket.sent)
      .map((payload) => JSON.parse(payload))

  const internal = session as unknown as {
    handleClientMessage: (
      socket: WebSocket,
      attachment: unknown,
      message: unknown
    ) => Promise<void>
    transientTaskExecutions: Map<string, unknown>
    transientAgentActivities: Map<string, unknown>
  }

  return {
    session,
    humanSocket,
    store,
    /**
     * Registers one resident socket like a fresh `/agent-events` upgrade: the
     * participant carries this nonce and the socket starts with an empty
     * hibernation attachment.
     */
    connectAgentSocket: (
      participantId: string,
      connectionNonce = `${participantId}-nonce`
    ): FakeSocket => {
      const socket: FakeSocket = {
        tag: `agent-event:${participantId}`,
        sent: [],
        attachment: {
          kind: "agent-event",
          participantId,
          connectionNonce,
          cursor: 0,
        },
        send(payload: string) {
          socket.sent.push(payload)
        },
        close: vi.fn(),
        serializeAttachment(value: unknown) {
          socket.attachment = value as Record<string, unknown>
        },
        deserializeAttachment: () => socket.attachment,
      }
      agentSockets.set(participantId, [
        ...participantSockets(participantId),
        socket,
      ])
      const participant = (store.get("room") as RoomRecord).participants[
        participantId
      ]
      if (participant) {
        participant.connected = true
        participant.connectionNonce = connectionNonce
      }
      return socket
    },
    sendHuman: (message: unknown, participantId = "human-1") =>
      internal.handleClientMessage(
        humanSocket,
        {
          participantId,
          token: `${participantId}-token`,
          connectionNonce: `${participantId}-connection`,
        },
        message
      ),
    stored: () => store.get("room") as RoomRecord,
    frames,
    errors: () =>
      frames()
        .filter((frame) => frame.type === "error")
        .map((frame) => frame.error),
    notices: () =>
      frames()
        .filter((frame) => frame.type === "task-control-notice")
        .map((frame) => frame.notice),
    agentFrames: parsedAgentFrames,
    agentControls: (participantId: string) =>
      parsedAgentFrames(participantId).filter(
        (frame) => frame.type === "task-control"
      ),
    agentResyncs: (participantId: string) =>
      parsedAgentFrames(participantId).filter(
        (frame) => frame.type === "task-execution-resync"
      ),
    /** The exact hibernation-durable attachment of the newest resident socket. */
    agentAttachment: (participantId: string) => {
      const sockets = participantSockets(participantId)
      return sockets[sockets.length - 1]?.attachment
    },
    activeTaskTurns: (participantId: string) =>
      (participantSockets(participantId)[
        participantSockets(participantId).length - 1
      ]?.attachment.activeTaskTurns ?? []) as Array<{
        taskRequestId: string
        turnSequence: number
      }>,
    /** Simulates a write the Room could not complete: a stale attachment. */
    setActiveTaskTurns: (
      participantId: string,
      turns: Array<{ taskRequestId: string; turnSequence: number }>
    ) => {
      const sockets = participantSockets(participantId)
      const socket = sockets[sockets.length - 1]
      if (socket) socket.attachment.activeTaskTurns = turns
    },
    clearAgentFrames: (participantId: string) => {
      for (const socket of participantSockets(participantId)) {
        socket.sent.length = 0
      }
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
    /** The authoritative projection, exactly as the Runtime publishes it. */
    publishExecution: (
      participantId: string,
      taskRequestId: string,
      projection: {
        currentTurnSequence?: number
        phase?: string
        queuedCount?: number
      }
    ) =>
      session.fetch(
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
            },
          }),
        })
      ),
    /** The presentation-only projection. */
    publishActivity: (
      participantId: string,
      scopeId: string,
      state: string,
      turnSequence: number
    ) =>
      session.fetch(
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
      ),
    /**
     * What hibernation does: memory-only projections are lost while the resident
     * socket, and therefore its durable attachment, survives.
     */
    simulateHibernation: () => {
      internal.transientTaskExecutions.clear()
      internal.transientAgentActivities.clear()
    },
    executions: () => [...internal.transientTaskExecutions.values()],
    activities: () => [...internal.transientAgentActivities.values()],
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
  const created = test
    .stored()
    .messages.filter((message) => message.collab?.kind === "request")
    .at(-1)
  const requestId = created?.collab?.requestId
  if (!requestId) throw new Error("canonical Task request was not created")
  return requestId
}

const instructions = (test: ReturnType<typeof harness>) =>
  test
    .stored()
    .messages.filter((message) => message.type === "text")
    .map((message) => message.text)

describe("#421 Task control authority (Fix C)", () => {
  it("A: execution N + matching activity N -> interrupt N is delivered", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    await test.publishActivity(
      "agent-a",
      `task:${requestId}`,
      "using_tools",
      42
    )
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
  })

  it("B: execution N with AgentActivity ABSENT -> interrupt N still works", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    // No activity at all: exactly the post-hibernation reconciliation state.
    expect(test.activities()).toEqual([])
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
    expect(test.agentControls("agent-a")).toHaveLength(1)
    expect(test.agentControls("agent-a")[0]).toMatchObject({ turnSequence: 42 })
  })

  it("C: execution N with STALE activity M -> control follows execution", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    await test.publishActivity("agent-a", `task:${requestId}`, "working", 41)
    test.clearAgentFrames("agent-a")

    // Naming the stale activity turn is refused...
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 41,
    })
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])

    // ...and the authoritative turn is the one that actually cancels.
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
  })

  it("D: no active execution turn + stale activity -> no control authority", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    // The Task settled: the authoritative projection reports only an outcome.
    await test.publishExecution("agent-a", requestId, {
      queuedCount: 0,
      phase: undefined as unknown as string,
    })
    // A stale presentation-only activity still claims turn 42.
    await test.publishActivity("agent-a", `task:${requestId}`, "working", 42)
    expect(test.activities()).toHaveLength(1)
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])
  })

  it("E: hibernation + reconciliation -> exact turn restored -> interrupt works", async () => {
    const test = harness()
    const agentSocket = test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    await test.publishActivity(
      "agent-a",
      `task:${requestId}`,
      "using_tools",
      42
    )
    test.clearAgentFrames("agent-a")

    // The Durable Object hibernates: both memory-only projections are gone,
    // while the resident socket and the local Harness keep working.
    test.simulateHibernation()
    expect(test.executions()).toEqual([])
    expect(test.activities()).toEqual([])

    // A returning Human's explicit resync is the ONE bounded reconciliation
    // trigger: no polling, no timer, nothing persisted.
    test.clearAgentFrames("agent-a")
    await test.sendHuman({ type: "resync" })
    expect(
      agentSocket.sent
        .map((payload) => JSON.parse(payload))
        .filter((frame) => frame.type === "task-execution-resync")
    ).toHaveLength(1)

    // The Runtime answers by re-stating the SAME authoritative projection.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    // Reconciliation is execution-only by design: AgentActivity stays absent.
    expect(test.activities()).toEqual([])

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
  })

  it("H: a stale or wrong turn never cancels the current one", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 47,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    for (const stale of [42, 46, 48, 1]) {
      await test.sendHuman({
        type: "task-interrupt",
        taskRequestId: requestId,
        turnSequence: stale,
      })
    }

    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual([
      "interrupt_turn_finished",
      "interrupt_turn_finished",
      "interrupt_turn_finished",
      "interrupt_turn_finished",
    ])
  })

  it("I: a unique replacement turn outranks a retained terminal projection and receives its exact interrupt", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")
    const requestId = await createTask(test)

    // A remains connected and has already settled an older execution. That
    // retained terminal state must not outrank an explicitly admitted B.
    await test.publishExecution("agent-a", requestId, { queuedCount: 0 })
    await test.sendHuman({
      type: "chat",
      text: "@agent-b take over this Task",
      targets: ["agent-a", "agent-b"],
      taskRequestId: requestId,
    })
    await test.publishExecution("agent-b", requestId, {
      currentTurnSequence: 88,
      phase: "running",
    })

    // Both per-Agent truths remain in RoomSession. The unique active turn is
    // B's, so controls can select B without erasing A's terminal projection.
    expect(test.executions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentParticipantId: "agent-a",
          taskRequestId: requestId,
          queuedCount: 0,
        }),
        expect.objectContaining({
          agentParticipantId: "agent-b",
          taskRequestId: requestId,
          currentTurnSequence: 88,
          phase: "running",
        }),
      ])
    )
    expect(test.executions()).toHaveLength(2)
    test.clearAgentFrames("agent-a")
    test.clearAgentFrames("agent-b")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 88,
    })

    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.agentControls("agent-b")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 88,
      },
    ])
  })

  it("preserves simultaneous Agent turns and fails closed for ambiguous controls", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")
    const requestId = await createTask(test)
    await test.sendHuman({
      type: "chat",
      text: "@agent-a and @agent-b work on this Task",
      targets: ["agent-a", "agent-b"],
      taskRequestId: requestId,
    })
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 10,
      phase: "running",
    })
    await test.publishExecution("agent-b", requestId, {
      currentTurnSequence: 20,
      phase: "running",
    })
    expect(test.executions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentParticipantId: "agent-a",
          taskRequestId: requestId,
          currentTurnSequence: 10,
        }),
        expect.objectContaining({
          agentParticipantId: "agent-b",
          taskRequestId: requestId,
          currentTurnSequence: 20,
        }),
      ])
    )
    expect(test.executions()).toHaveLength(2)
    test.clearAgentFrames("agent-a")
    test.clearAgentFrames("agent-b")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 10,
    })
    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 20,
      text: "do not guess which Agent to stop",
    })

    expect(test.errors()).toEqual([
      "task_execution_ambiguous",
      "task_execution_ambiguous",
    ])
    expect(instructions(test)).toEqual([
      "@agent-a and @agent-b work on this Task",
    ])
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.agentControls("agent-b")).toEqual([])
  })
})

describe("#421 Interrupt & send race (Fix D/G)", () => {
  it("F: the old turn is still active -> one canonical instruction, one exact steer", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "stop and do this instead",
    })

    // The replacement is stored EXACTLY once, as a canonical Task instruction,
    // BEFORE any private control is dispatched (#484).
    expect(instructions(test)).toEqual(["stop and do this instead"])
    const instruction = test.stored().messages.at(-1)
    expect(instruction?.taskRequestId).toBe(requestId)
    expect(instruction?.targets).toEqual(["agent-a"])
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
    // Interrupt & Send is STEER: the control names the persisted instruction by
    // its canonical sequence and carries no instruction text at all.
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "steer",
        taskRequestId: requestId,
        turnSequence: 42,
        steerInstructionSequence: instruction?.sequence,
      },
    ])
    expect(
      "text" in (test.agentControls("agent-a")[0] as Record<string, unknown>)
    ).toBe(false)
  })

  it("F2: a replacement executor receives both the queued instruction and exact steer", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, { queuedCount: 0 })
    await test.sendHuman({
      type: "chat",
      text: "@agent-b take over this Task",
      targets: ["agent-b"],
      taskRequestId: requestId,
    })
    await test.publishExecution("agent-b", requestId, {
      currentTurnSequence: 88,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.clearAgentFrames("agent-b")

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 88,
      text: "continue with the corrected plan",
    })

    expect(test.stored().messages.at(-1)?.taskRequestId).toBe(requestId)
    expect(test.stored().messages.at(-1)?.targets).toEqual(["agent-b"])
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.agentControls("agent-b")).toEqual([
      {
        type: "task-control",
        control: "steer",
        taskRequestId: requestId,
        turnSequence: 88,
        steerInstructionSequence: test.stored().messages.at(-1)?.sequence,
      },
    ])
  })

  it("G: the old turn settles in the race -> instruction preserved, no raw error", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    // The turn the Human saw is already gone when the command lands.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 47,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "the replacement must survive",
    })

    // Exactly once, still canonical and still addressed to the Task Agent, so
    // the next instruction executes as a normal queued Task instruction.
    expect(instructions(test)).toEqual(["the replacement must survive"])
    expect(test.stored().messages.at(-1)?.taskRequestId).toBe(requestId)
    expect(test.stored().messages.at(-1)?.targets).toEqual(["agent-a"])
    // The LATER turn 47 is never steered or cancelled by a stale turn-42
    // request: no control at all is dispatched.
    expect(test.agentControls("agent-a")).toEqual([])
    // No raw protocol code and no scary operation failure.
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual(["instruction_queued_turn_finished"])
  })

  it("G: a stale Interrupt & send is not a blanket success for standalone Interrupt", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 47,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "queued anyway",
    })
    // Standalone Interrupt keeps the strict exact-turn contract.
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual([
      "instruction_queued_turn_finished",
      "interrupt_turn_finished",
    ])
  })

  it("rejects a genuinely unauthorized interrupt & send without losing anything", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    await createTask(test)
    const otherTask = await createTask(test, "agent-b")
    // The second Task's canonical Agent endpoint is gone.
    test.stored().participants["agent-b"].connected = false
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: "not-a-task",
      turnSequence: 42,
      text: "must not be appended",
    })
    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: otherTask,
      turnSequence: 42,
      text: "must not be appended either",
    })

    expect(instructions(test)).toEqual([])
    expect(test.errors()).toEqual([
      "unknown_task_request",
      "task_target_not_in_room",
    ])
  })

  it("rejects a malformed turn as a protocol violation", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 0,
      text: "not appended",
    })

    expect(instructions(test)).toEqual([])
    expect(test.errors()).toEqual(["invalid_task_turn"])
  })
})

/**
 * Exact Task control authority after Durable Object hibernation. Execution
 * projections are memory-only, so the Room recovers the exact turn from the
 * resident socket's hibernation attachment. Hibernation is explicit here and the
 * Runtime's answers are driven by the test, never by a real browser.
 */
describe("#480 hibernation-durable Task control authority", () => {
  it("1: warm Room -> exact turn controlled, and mirrored into the attachment", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    await test.publishActivity(
      "agent-a",
      `task:${requestId}`,
      "using_tools",
      42
    )

    // The same authority is mirrored durably.
    expect(test.activeTaskTurns("agent-a")).toEqual([
      { taskRequestId: requestId, turnSequence: 42 },
    ])
    test.clearAgentFrames("agent-a")

    // A stale attachment never outranks in-memory truth.
    test.setActiveTaskTurns("agent-a", [
      { taskRequestId: requestId, turnSequence: 41 },
    ])
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 41,
    })
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
  })

  it("2: hibernation with no Human resync -> the attachment restores exact authority", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")

    test.simulateHibernation()
    expect(test.executions()).toEqual([])

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
    // No reconciliation frame: authority came from the attachment.
    expect(test.agentResyncs("agent-a")).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
    // ...from the attachment that survived the eviction.
    expect(test.activeTaskTurns("agent-a")).toEqual([
      { taskRequestId: requestId, turnSequence: 42 },
    ])
  })

  it("3: a successor turn after hibernation is never cancelled by the old turn", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    // The Room hibernates with the successor already recorded.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 43,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.simulateHibernation()

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])

    // The successor is still controllable by its own exact turn.
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 43,
    })
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 43,
      },
    ])

    // Same for a successor the Room only learns about after waking.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 44,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.simulateHibernation()
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 43,
    })
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual([
      "interrupt_turn_finished",
      "interrupt_turn_finished",
    ])
  })

  it("4: a replacement Agent executor owns the Task after hibernation", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")
    const requestId = await createTask(test)

    // A was the initial executor and has settled; B is the replacement.
    await test.publishExecution("agent-a", requestId, { queuedCount: 0 })
    await test.sendHuman({
      type: "chat",
      text: "@agent-b take over this Task",
      targets: ["agent-a", "agent-b"],
      taskRequestId: requestId,
    })
    await test.publishExecution("agent-b", requestId, {
      currentTurnSequence: 88,
      phase: "running",
    })

    // A settled Task keeps no entry: only current turns are stored.
    expect(test.activeTaskTurns("agent-a")).toEqual([])
    expect(test.activeTaskTurns("agent-b")).toEqual([
      { taskRequestId: requestId, turnSequence: 88 },
    ])
    test.clearAgentFrames("agent-a")
    test.clearAgentFrames("agent-b")

    test.simulateHibernation()
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 88,
    })

    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.agentControls("agent-b")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 88,
      },
    ])
  })

  it("5: two active Agents on one Task stay ambiguous after hibernation", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")
    const requestId = await createTask(test)
    await test.sendHuman({
      type: "chat",
      text: "@agent-a and @agent-b work on this Task",
      targets: ["agent-a", "agent-b"],
      taskRequestId: requestId,
    })
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 10,
      phase: "running",
    })
    await test.publishExecution("agent-b", requestId, {
      currentTurnSequence: 20,
      phase: "running",
    })
    expect(test.activeTaskTurns("agent-a")).toEqual([
      { taskRequestId: requestId, turnSequence: 10 },
    ])
    expect(test.activeTaskTurns("agent-b")).toEqual([
      { taskRequestId: requestId, turnSequence: 20 },
    ])
    test.clearAgentFrames("agent-a")
    test.clearAgentFrames("agent-b")

    test.simulateHibernation()
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 10,
    })
    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 20,
      text: "do not guess which Agent to stop",
    })

    expect(test.errors()).toEqual([
      "task_execution_ambiguous",
      "task_execution_ambiguous",
    ])
    expect(instructions(test)).toEqual([
      "@agent-a and @agent-b work on this Task",
    ])
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.agentControls("agent-b")).toEqual([])
  })

  it("6: a stale attachment can only ever name its own exact turn", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.simulateHibernation()

    // The Runtime already moved to 43 but never published it, so the only truth
    // is the stale attachment. The successor is refused, and the control that is
    // written for 42 names exactly 42 — never a scope-only cancel — so the
    // Runtime can still refuse it.
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 43,
    })
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])

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
    for (const control of test.agentControls("agent-a")) {
      expect(control.taskRequestId).toBe(requestId)
      expect(control.turnSequence).toBeGreaterThan(0)
    }

    // Once the Room has the successor, the stale turn is refused outright.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 43,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual([
      "interrupt_turn_finished",
      "interrupt_turn_finished",
    ])
  })

  it("7: a replaced socket's attachment is dead authority", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.simulateHibernation()

    // The resident reconnects: same participant, new connectionNonce, fresh
    // empty attachment. The previous socket stays registered with its stale
    // attachment, so only the nonce binding can fence it.
    const replacement = test.connectAgentSocket("agent-a", "agent-a-nonce-2")
    expect(test.stored().participants["agent-a"].connectionNonce).toBe(
      "agent-a-nonce-2"
    )
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    expect(test.errors()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])

    // The replacement socket's own projection restores authority.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    expect(replacement.attachment.activeTaskTurns).toEqual([
      { taskRequestId: requestId, turnSequence: 42 },
    ])
    test.clearAgentFrames("agent-a")
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
  })

  it("8: the attachment stores current turns only, within its product bound", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const total = MAX_ATTACHMENT_ACTIVE_TASK_TURNS + 3
    const requestIds: string[] = []
    for (let index = 0; index < total; index += 1) {
      const requestId = await createTask(test)
      requestIds.push(requestId)
      await test.publishExecution("agent-a", requestId, {
        currentTurnSequence: 100 + index,
        phase: "running",
      })
    }

    const turns = test.activeTaskTurns("agent-a")
    // The explicit bound holds, and the newest turns survive it.
    expect(turns).toHaveLength(MAX_ATTACHMENT_ACTIVE_TASK_TURNS)
    expect(turns.map((turn) => turn.taskRequestId)).toEqual(
      requestIds.slice(total - MAX_ATTACHMENT_ACTIVE_TASK_TURNS)
    )
    // Nothing but known current Task turns is ever present.
    expect(turns.every((turn) => requestIds.includes(turn.taskRequestId))).toBe(
      true
    )

    // A Task with no current turn is removed, so no history accumulates.
    const newest = requestIds[requestIds.length - 1]
    await test.publishExecution("agent-a", newest, { queuedCount: 0 })
    expect(
      test.activeTaskTurns("agent-a").map((turn) => turn.taskRequestId)
    ).not.toContain(newest)
    expect(test.activeTaskTurns("agent-a")).toHaveLength(
      MAX_ATTACHMENT_ACTIVE_TASK_TURNS - 1
    )
  })
})

/**
 * #484: Interrupt & Send is STEER, not a second cancel.
 *
 * The Human's replacement instruction is canonical Room input that the Room
 * persists BEFORE it dispatches anything, and the private control only names
 * that instruction by its canonical sequence. Priority is therefore a Runtime
 * delivery decision over accepted canonical events — never a rewrite of Room
 * history, and never a second durable copy of the instruction text.
 */
describe("#484 Interrupt & Send is Steer", () => {
  it("persists the canonical instruction before dispatching a control that only names it", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    const sequencesBefore = test.stored().messages.map((m) => m.sequence)
    test.clearAgentFrames("agent-a")

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "steer toward the new plan",
    })

    // Exactly one canonical instruction, appended after the turn it reacts to.
    const stored = test.stored().messages
    const instruction = stored.at(-1)
    expect(instruction?.type).toBe("text")
    expect(instruction?.text).toBe("steer toward the new plan")
    expect(instruction?.taskRequestId).toBe(requestId)
    expect(instruction?.targets).toEqual(["agent-a"])
    // Canonical append order: this instruction is the newest Room sequence, so
    // the private control's steer identity is a real canonical sequence (the
    // turn number above is a published projection value, not a Room sequence).
    expect(instruction?.sequence).toBe(
      Math.max(...stored.map((message) => message.sequence))
    )
    expect(Number.isSafeInteger(instruction?.sequence)).toBe(true)
    // Durable Room history is only appended to: storage order is unchanged.
    expect(
      stored.slice(0, sequencesBefore.length).map((m) => m.sequence)
    ).toEqual(sequencesBefore)

    // The private control names that exact instruction and carries no text.
    const controls = test.agentControls("agent-a")
    expect(controls).toEqual([
      {
        type: "task-control",
        control: "steer",
        taskRequestId: requestId,
        turnSequence: 42,
        steerInstructionSequence: instruction?.sequence,
      },
    ])
    expect(JSON.stringify(controls)).not.toContain("steer toward the new plan")

    // Steering is not a second cancel command: a standalone Interrupt remains
    // the only thing that dispatches a plain `interrupt` control.
    test.clearAgentFrames("agent-a")
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
  })
})
