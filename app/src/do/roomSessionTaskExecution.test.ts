import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

/**
 * #409 Remote Task execution: the Room ingests the Runtime-authoritative
 * transient execution projection, and owns the ONE structured
 * "interrupt & send" ordering guarantee.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

interface FakeAgentSocket {
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
  // A single ordered log so tests can assert the persist-then-interrupt order
  // of the structured command instead of guessing at timing.
  const events: string[] = []
  let puts = 0
  const humanSocket = { send: vi.fn(), close: vi.fn() } as unknown as WebSocket
  const agentSockets = new Map<string, FakeAgentSocket>()

  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        puts += 1
        events.push("persist")
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

  const control = async (body: Record<string, unknown>) => {
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
  }

  return {
    session,
    events,
    control,
    connectAgentSocket: (participantId: string): FakeAgentSocket => {
      const socket: FakeAgentSocket = {
        tag: `agent-event:${participantId}`,
        sent: [],
        send(payload: string) {
          events.push(`control:${participantId}`)
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
    disconnectAgentSocket: (participantId: string) => {
      agentSockets.delete(participantId)
    },
    sendHuman: (message: unknown, participantId = "human-1") =>
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
          token: `${participantId}-token`,
          connectionNonce: `${participantId}-connection`,
        },
        message
      ),
    stored: () => store.get("room") as RoomRecord,
    putCount: () => puts,
    errorFrames: () =>
      (humanSocket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .filter((frame) => frame.type === "error")
        .map((frame) => frame.error),
    broadcasts: () =>
      (humanSocket.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
        JSON.parse(call[0] as string)
      ),
    agentControls: (participantId: string) =>
      (agentSockets.get(participantId)?.sent ?? [])
        .map((payload) => JSON.parse(payload))
        .filter((frame) => frame.type === "task-control"),
    executions: () =>
      [
        ...(
          session as unknown as {
            transientTaskExecutions: Map<string, unknown>
          }
        ).transientTaskExecutions.values(),
      ] as Record<string, unknown>[],
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
  const requestId = test.stored().messages[0].collab?.requestId
  if (!requestId) throw new Error("canonical Task request was not created")
  return requestId
}

/**
 * #421 Fix C: the AUTHORITATIVE Task execution projection. Interrupt and
 * "interrupt & send" resolve their exact turn from this, never from the
 * presentation-only AgentActivity.
 */
async function publishExecution(
  test: ReturnType<typeof harness>,
  requestId: string,
  turnSequence: number,
  participantId = "agent-a"
) {
  return test.control({
    action: "agent-task-execution",
    participantId,
    token: `${participantId}-token`,
    projection: {
      taskRequestId: requestId,
      currentTurnSequence: turnSequence,
      phase: "running",
      queuedCount: 0,
    },
  })
}

describe("RoomSession transient Task execution (#409)", () => {
  it("accepts, broadcasts, and never persists a canonical Agent projection", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    const putsBefore = test.putCount()
    const sequenceBefore = test.stored().nextMessageSequence

    const published = await test.control({
      action: "agent-task-execution",
      participantId: "agent-a",
      token: "agent-a-token",
      projection: {
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "running",
        queuedCount: 2,
      },
    })

    expect(published).toMatchObject({ status: 200, json: { ok: true } })
    expect(test.executions()).toEqual([
      {
        agentParticipantId: "agent-a",
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "running",
        queuedCount: 2,
      },
    ])
    expect(
      test
        .broadcasts()
        .filter((frame) => frame.type === "taskExecution")
        .map((frame) => frame.execution)
    ).toEqual([
      {
        agentParticipantId: "agent-a",
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "running",
        queuedCount: 2,
      },
    ])
    // Transient only: no Room write at all, no sequence, no message.
    expect(test.putCount()).toBe(putsBefore)
    expect(test.stored().nextMessageSequence).toBe(sequenceBefore)
  })

  it("accepts a QUEUED projection for a Task waiting on an execution lane (#421)", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)

    // No current turn and real accepted work waiting: the truthful
    // "waiting for capacity" state, which must be storable and renderable
    // instead of leaving the Human with an apparently hung Task.
    const published = await test.control({
      action: "agent-task-execution",
      participantId: "agent-a",
      token: "agent-a-token",
      projection: { taskRequestId: requestId, phase: "queued", queuedCount: 3 },
    })
    expect(published).toMatchObject({ status: 200, json: { ok: true } })
    expect(test.executions()).toEqual([
      {
        agentParticipantId: "agent-a",
        taskRequestId: requestId,
        phase: "queued",
        queuedCount: 3,
      },
    ])
    expect(
      test
        .broadcasts()
        .filter((frame) => frame.type === "taskExecution")
        .map((frame) => frame.execution)
    ).toEqual([
      {
        agentParticipantId: "agent-a",
        taskRequestId: requestId,
        phase: "queued",
        queuedCount: 3,
      },
    ])
  })

  it("rejects a self-contradictory queued projection", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)

    for (const projection of [
      // Queued with nothing waiting claims a wait that does not exist.
      { taskRequestId: requestId, phase: "queued", queuedCount: 0 },
      // Queued WITH a current turn contradicts itself: queued means no turn
      // is executing.
      {
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "queued",
        queuedCount: 1,
      },
    ]) {
      const rejected = await test.control({
        action: "agent-task-execution",
        participantId: "agent-a",
        token: "agent-a-token",
        projection,
      })
      expect(rejected.status).toBe(400)
    }
    expect(test.executions()).toEqual([])
  })

  it("rejects a secondary participating Agent and malformed projections", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)

    // agent-b is not the canonical endpoint of this Task.
    const secondary = await test.control({
      action: "agent-task-execution",
      participantId: "agent-b",
      token: "agent-b-token",
      projection: {
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "running",
        queuedCount: 0,
      },
    })
    expect(secondary.status).toBe(400)

    for (const projection of [
      { taskRequestId: requestId, queuedCount: -1 },
      { taskRequestId: requestId, queuedCount: 1.5 },
      { taskRequestId: requestId, queuedCount: 1000 },
      { taskRequestId: requestId, currentTurnSequence: 0, queuedCount: 0 },
      {
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "moving",
        queuedCount: 0,
      },
      // A phase without a current turn is a claim about nothing.
      { taskRequestId: requestId, phase: "running", queuedCount: 0 },
      {
        taskRequestId: requestId,
        currentTurnSequence: 42,
        phase: "running",
        queuedCount: 0,
        availability: "confused",
      },
      { queuedCount: 0 },
      "nonsense",
    ]) {
      const rejected = await test.control({
        action: "agent-task-execution",
        participantId: "agent-a",
        token: "agent-a-token",
        projection,
      })
      expect(rejected.status).toBe(400)
    }
    expect(test.executions()).toEqual([])
  })

  it("keeps the projection bound to the current resident connection", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.control({
      action: "agent-task-execution",
      participantId: "agent-a",
      token: "agent-a-token",
      projection: { taskRequestId: requestId, queuedCount: 1 },
    })
    expect(test.executions()).toHaveLength(1)

    // A replaced resident socket is a fresh transient boundary: stale
    // execution truth must not survive it.
    test.disconnectAgentSocket("agent-a")
    await (
      test.session as unknown as {
        handleAgentEventClose: (
          socket: unknown,
          attachment: unknown
        ) => Promise<void>
      }
    ).handleAgentEventClose(null, {
      kind: "agent-event",
      participantId: "agent-a",
      connectionNonce: "agent-a-nonce",
      cursor: 0,
    })
    expect(test.executions()).toEqual([])
  })
})

describe("RoomSession interrupt & send (#409)", () => {
  it("persists the instruction before dispatching the exact-turn interrupt", async () => {
    const test = harness()
    const agentSocket = test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await publishExecution(test, requestId, 42)

    const messagesBefore = test.stored().messages.length
    test.events.length = 0

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "Use the other approach instead.",
    })

    // Exactly one canonical Task text instruction, targeted at the canonical
    // Agent, appended and persisted before the private interrupt frame.
    const stored = test.stored()
    expect(stored.messages).toHaveLength(messagesBefore + 1)
    const instruction = stored.messages[stored.messages.length - 1]
    expect(instruction).toMatchObject({
      peerId: "human-1",
      text: "Use the other approach instead.",
      taskRequestId: requestId,
      targets: ["agent-a"],
    })
    expect(test.errorFrames()).toEqual([])
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
    expect(agentSocket.close).not.toHaveBeenCalled()

    // The ordering guarantee: persistence strictly precedes the interrupt.
    const persistIndex = test.events.indexOf("persist")
    const interruptIndex = test.events.indexOf("control:agent-a")
    expect(persistIndex).toBeGreaterThanOrEqual(0)
    expect(interruptIndex).toBeGreaterThan(persistIndex)

    // The instruction is broadcast through the ordinary Task path and wakes
    // waiters, so it is a normal queued follow-up for the Runtime.
    expect(
      test
        .broadcasts()
        .filter((frame) => frame.type === "message")
        .map((frame) => frame.message.text)
        .filter((text) => typeof text === "string")
    ).toEqual(["Use the other approach instead."])
  })

  it("keeps the instruction queued when the interrupt cannot be delivered", async () => {
    const test = harness()
    // The canonical Agent is connected in Room state but holds no socket.
    const requestId = await createTask(test)
    await publishExecution(test, requestId, 42)

    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "Keep this instruction.",
    })

    expect(test.errorFrames()).toEqual([
      "instruction_queued_interrupt_unavailable",
    ])
    // Truthful partial success: no rollback of the durable instruction.
    const stored = test.stored()
    expect(stored.messages[stored.messages.length - 1]).toMatchObject({
      text: "Keep this instruction.",
      taskRequestId: requestId,
      targets: ["agent-a"],
    })
  })

  it("never loses the replacement when the named turn is already gone", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await publishExecution(test, requestId, 42)
    const messagesBefore = test.stored().messages.length

    // #421 Fix D: the turn the Human saw (41) had already settled. The
    // instruction is a valid canonical Task instruction and must still be
    // queued exactly once; only the interrupt is skipped, and the LIVE turn
    // 42 is never cancelled by a stale request.
    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 41,
      text: "stale but must survive",
    })
    expect(test.errorFrames()).toEqual([])
    expect(
      test
        .broadcasts()
        .filter((frame) => frame.type === "task-control-notice")
        .map((frame) => frame.notice)
    ).toEqual(["instruction_queued_turn_finished"])
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.stored().messages).toHaveLength(messagesBefore + 1)
    expect(test.stored().messages[messagesBefore]).toMatchObject({
      text: "stale but must survive",
      taskRequestId: requestId,
      targets: ["agent-a"],
    })

    // An unknown Task and an empty instruction stay hard refusals with no
    // side effects at all.
    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: "unknown-task",
      turnSequence: 42,
      text: "nowhere",
    })
    await test.sendHuman({
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "   ",
    })
    expect(test.errorFrames()).toEqual([
      "unknown_task_request",
      "invalid_task_instruction",
    ])
    expect(test.stored().messages).toHaveLength(messagesBefore + 1)
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("keeps ordinary Task chat unchanged and appends no control", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    const messagesBefore = test.stored().messages.length

    await test.sendHuman({
      type: "chat",
      text: "ordinary task follow-up",
      taskRequestId: requestId,
    })

    const stored = test.stored()
    expect(stored.messages).toHaveLength(messagesBefore + 1)
    expect(stored.messages[stored.messages.length - 1]).toMatchObject({
      text: "ordinary task follow-up",
      taskRequestId: requestId,
      targets: ["agent-a"],
    })
    expect(test.agentControls("agent-a")).toEqual([])
    expect(test.errorFrames()).toEqual([])
  })
})
