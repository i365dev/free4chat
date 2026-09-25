import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
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
  send: (payload: string) => void
  close: ReturnType<typeof vi.fn>
  serializeAttachment: ReturnType<typeof vi.fn>
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
  const agentSockets = new Map<string, FakeSocket>()

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
        ? [...agentSockets.values(), humanSocket]
        : [...agentSockets.values()].filter(
            (socket) => socket.tag === tag
          )) as unknown as WebSocket[],
  }

  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)

  const frames = () =>
    (humanSocket.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      JSON.parse(call[0] as string)
    )

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
    connectAgentSocket: (participantId: string): FakeSocket => {
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
          cursor: 0,
        }),
      }
      agentSockets.set(participantId, socket)
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
    agentFrames: (participantId: string) =>
      (agentSockets.get(participantId)?.sent ?? []).map((payload) =>
        JSON.parse(payload)
      ),
    agentControls: (participantId: string) =>
      (agentSockets.get(participantId)?.sent ?? [])
        .map((payload) => JSON.parse(payload))
        .filter((frame) => frame.type === "task-control"),
    agentResyncs: (participantId: string) =>
      (agentSockets.get(participantId)?.sent ?? [])
        .map((payload) => JSON.parse(payload))
        .filter((frame) => frame.type === "task-execution-resync"),
    clearAgentFrames: (participantId: string) => {
      const socket = agentSockets.get(participantId)
      if (socket) socket.sent.length = 0
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
     * What a hibernating Durable Object does to MEMORY-ONLY projections: both
     * transient maps are lost while the resident socket and the local Harness
     * survive.
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

/**
 * #480 — the real-Room G4 failure.
 *
 * A Human stayed in the Room with a browser WebSocket that never reconnected,
 * so the browser kept rendering the Running projection it had already received.
 * The Durable Object, however, is hibernatable: it can be evicted while both the
 * Human socket and the resident Agent socket stay open, and it comes back with
 * its MEMORY-ONLY `transientTaskExecutions` map empty.
 *
 * The pre-fix Room treated "no authoritative execution entry" as "that turn is
 * not active", answered `interrupt_turn_finished`, and never wrote a
 * `task-control` frame — so the Runtime was never asked, Task A never entered
 * Interrupting, and the long turn simply ran to completion.
 *
 * The pre-fix shape is deterministic and was captured on the unfixed source:
 *
 *   Room accepts task-interrupt(A, 42)
 *   -> resident socket receives NOTHING (no task-execution-resync, no control)
 *   -> Human socket receives {"type":"task-control-notice",
 *      "notice":"interrupt_turn_finished"}
 *
 * which is exactly the real-Room G4 observation (no Interrupting, no
 * Interrupted, no "Interrupt unavailable", Task A completing normally, Task B
 * unaffected). It is also the expected state after ~10s of Durable Object
 * inactivity: the resident's own lease heartbeat is only a 15s backoff hint, so
 * a 300s Task leaves the Room hibernated and the Human's click is the event that
 * wakes it.
 *
 * These regressions are deterministic: the hibernation is explicit, and the
 * Runtime's answer is driven by the test instead of by a real browser.
 */
describe("#480 hibernated Room: the first exact Task control still reaches the resident", () => {
  it("B: memory-only execution lost, Human socket kept, NO explicit resync -> exact interrupt N lands", async () => {
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
    expect(test.executions()).toHaveLength(1)
    test.clearAgentFrames("agent-a")

    // The Durable Object hibernates. The resident socket survives, the local
    // Harness keeps working, and the browser keeps its own cached Running
    // projection for turn 42 — which is exactly why the Human can still click.
    test.simulateHibernation()
    expect(test.executions()).toEqual([])
    expect(test.activities()).toEqual([])

    // No `resync`, no reconnect, no explicit reconciliation: the Human's first
    // real Task control is the interrupt itself.
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    // The Room cannot verify the exact turn from memory, so it asks the ONE
    // resident that owns the Task to re-state its authoritative execution
    // instead of guessing, and it does not invent a control yet.
    expect(test.agentResyncs("agent-a")).toEqual([
      { type: "task-execution-resync" },
    ])
    expect(test.agentControls("agent-a")).toEqual([])

    // The Runtime answers with the SAME authoritative projection.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })

    // Only now, with current == the requested turn, is the exact control sent.
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
    // The reconciliation frame is a one-shot request, not a poll.
    expect(test.agentResyncs("agent-a")).toHaveLength(1)
    expect(agentSocket.sent).toHaveLength(2)
  })

  it("C: recovery finds a successor turn instead -> the held N never cancels N+1", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.simulateHibernation()

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    expect(test.agentResyncs("agent-a")).toHaveLength(1)
    expect(test.agentControls("agent-a")).toEqual([])

    // The Task genuinely moved on while the Room had no truth: the authority is
    // now turn 43.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 43,
      phase: "running",
    })

    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])

    // The successor is still fully controllable by its OWN exact turn, so the
    // held stale click did not consume or poison it.
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
    // The one-shot reconciliation is never repeated for the fresh click: the
    // Room now HAS the authoritative turn.
    expect(test.agentResyncs("agent-a")).toHaveLength(1)
  })

  it("D: Task B is untouched by Task A's recovery", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    test.connectAgentSocket("agent-b")
    const requestId = await createTask(test)
    const otherRequestId = await createTask(test, "agent-b")
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 10,
      phase: "running",
    })
    await test.publishExecution("agent-b", otherRequestId, {
      currentTurnSequence: 20,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.clearAgentFrames("agent-b")
    test.simulateHibernation()

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 10,
    })

    // Only the clicked Task's own executor is asked.
    expect(test.agentResyncs("agent-a")).toHaveLength(1)
    expect(test.agentResyncs("agent-b")).toEqual([])
    expect(test.agentControls("agent-b")).toEqual([])

    // Both residents re-state; only A receives a control.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 10,
      phase: "running",
    })
    await test.publishExecution("agent-b", otherRequestId, {
      currentTurnSequence: 20,
      phase: "running",
    })

    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 10,
      },
    ])
    expect(test.agentControls("agent-b")).toEqual([])
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
  })

  it("E: recovery answers with a settled Task -> benign no-op, never a later turn", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.simulateHibernation()

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    expect(test.agentResyncs("agent-a")).toHaveLength(1)

    // The Task finished while the Room was asleep: the resident truthfully
    // reports no current turn and no queued work.
    await test.publishExecution("agent-a", requestId, { queuedCount: 0 })

    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual(["interrupt_turn_finished"])

    // A LATER turn of the same Task is never hit by the settled click.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 77,
      phase: "running",
    })
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("F: an unanswered hold expires with a truthful outcome and can never fire later", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.simulateHibernation()

    const clock = vi.spyOn(Date, "now")
    const startedAt = Date.now()
    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    expect(test.agentResyncs("agent-a")).toHaveLength(1)
    expect(test.errors()).toEqual([])

    // The resident never answers. The bounded wait is swept by the next Human
    // event, and the Human is told the truth instead of being left guessing.
    clock.mockReturnValue(startedAt + 60 * 1000)
    await test.sendHuman({ type: "resync" })
    clock.mockRestore()

    expect(test.errors()).toEqual(["task_agent_not_reachable"])
    expect(test.notices()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([])

    // An answer that arrives after the window cannot resurrect the expired
    // click: the Human was already told it did not happen.
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    expect(test.agentControls("agent-a")).toEqual([])
  })
})

describe("#480 hibernated Room: interrupt & send", () => {
  it("keeps the instruction durable and still stops the exact turn it names", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.simulateHibernation()

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "stop and do this instead",
    })

    // The instruction is durable immediately and exactly once — it is never a
    // gate on the interrupt, and never lost to the reconciliation.
    expect(instructions(test)).toEqual(["stop and do this instead"])
    expect(test.agentResyncs("agent-a")).toHaveLength(1)
    expect(test.agentControls("agent-a")).toEqual([])

    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })

    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual([])
  })

  it("a settled recovery keeps the queued instruction and reports the benign outcome", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, {
      currentTurnSequence: 42,
      phase: "running",
    })
    test.clearAgentFrames("agent-a")
    test.simulateHibernation()

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "the replacement must survive",
    })
    await test.publishExecution("agent-a", requestId, { queuedCount: 0 })

    expect(instructions(test)).toEqual(["the replacement must survive"])
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.errors()).toEqual([])
    expect(test.notices()).toEqual(["instruction_queued_turn_finished"])
  })
})

describe("#421 Interrupt & send race (Fix D/G)", () => {
  it("F: the old turn is still active -> one instruction, one exact interrupt", async () => {
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

    // The replacement is stored EXACTLY once, as a canonical Task instruction.
    expect(instructions(test)).toEqual(["stop and do this instead"])
    expect(test.stored().messages.at(-1)?.taskRequestId).toBe(requestId)
    expect(test.stored().messages.at(-1)?.targets).toEqual(["agent-a"])
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

  it("F2: a replacement executor receives both the queued instruction and exact interrupt", async () => {
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
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 88,
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
    // The LATER turn 47 is never cancelled by a stale turn-42 request.
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
