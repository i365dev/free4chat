import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

/**
 * #421 Room-shared Task supervision.
 *
 * Free4Chat is an anonymous temporary Room. A Human who starts a long Task may
 * leave for longer than the reconnect grace, after which the original
 * ephemeral Human participant is removed; returning to the Room creates a NEW
 * Human participant id.
 *
 * Supervision of an ALREADY-CREATED canonical Task is therefore Room-shared
 * between current authenticated Humans — exactly like sending a Task follow-up
 * or resolving the Task's permission request, both of which already worked for
 * any current Human. The original fromParticipantId remains canonical
 * provenance/history and is never an authorization credential.
 *
 * What must NOT weaken: the caller is a current authenticated Human, the
 * canonical Task exists, its canonical Agent endpoint is reachable, and the
 * named turn is the exact currently active one.
 *
 * PRE-TASK local session selection (#420) is a different boundary and stays
 * bound to the exact discovering Human; these tests do not touch it.
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
  const stored = () => store.get("room") as RoomRecord

  const deliver = (
    participantId: string,
    token: string,
    message: unknown,
    socket: WebSocket = humanSocket
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
      socket,
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
    stored,
    deliver,
    connectAgentSocket: (
      participantId: string,
      connected = true
    ): FakeSocket => {
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
      const record = stored()
      record.participants[participantId] = agent(participantId, connected)
      return socket
    },
    sendHuman: (message: unknown, participantId = "human-1") =>
      deliver(participantId, `${participantId}-token`, message),
    /** The Room removes an expired Human exactly like the reconnect grace does. */
    expireHuman: (participantId: string) => {
      delete stored().participants[participantId]
    },
    joinHuman: (participantId: string) => {
      stored().participants[participantId] = human(
        participantId,
        `${participantId}-token`
      )
    },
    errorFrames: (socket: WebSocket = humanSocket) =>
      (socket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .filter((frame) => frame.type === "error")
        .map((frame) => frame.error),
    agentControls: (participantId: string) =>
      (agentSockets.get(participantId)?.sent ?? [])
        .map((payload) => JSON.parse(payload))
        .filter((frame) => frame.type === "task-control"),
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
      return { status: response.status }
    },
    /**
     * #421 Fix C: the AUTHORITATIVE Task execution projection. Interrupt
     * authorization reads this, never AgentActivity.
     */
    publishExecution: async (
      participantId: string,
      taskRequestId: string,
      currentTurnSequence: number
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
              currentTurnSequence,
              phase: "running",
              queuedCount: 0,
            },
          }),
        })
      )
      return { status: response.status }
    },
    /** #421 Fix G: benign control outcomes are not error frames. */
    notices: (socket: WebSocket = humanSocket) =>
      (socket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .filter((frame) => frame.type === "task-control-notice")
        .map((frame) => frame.notice),
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
  const requestId = test.stored().messages[0]?.collab?.requestId
  if (!requestId) throw new Error("canonical Task request was not created")
  return requestId
}

/** The exact legal lifecycle: creator expires, then a fresh Human returns. */
async function creatorLeftAndHumanReturned(test: ReturnType<typeof harness>) {
  test.connectAgentSocket("agent-a")
  const requestId = await createTask(test)
  await test.publishExecution("agent-a", requestId, 42)
  test.expireHuman("human-1")
  test.joinHuman("human-returned")
  return requestId
}

describe("Room-shared Task supervision after the creator expires (#421)", () => {
  it("lets a returning Human send a Task follow-up into the retained Task", async () => {
    const test = harness()
    const requestId = await creatorLeftAndHumanReturned(test)
    const before = test.stored().messages.length

    await test.sendHuman(
      { type: "chat", text: "status?", taskRequestId: requestId },
      "human-returned"
    )

    expect(test.errorFrames()).toEqual([])
    const messages = test.stored().messages
    expect(messages).toHaveLength(before + 1)
    expect(messages[messages.length - 1].text).toBe("status?")
    expect(messages[messages.length - 1].taskRequestId).toBe(requestId)
    // Provenance is preserved: the Task still records its original creator.
    expect(messages[0].collab?.fromParticipantId).toBe("human-1")
  })

  it("lets a returning Human interrupt the exact live turn", async () => {
    const test = harness()
    const requestId = await creatorLeftAndHumanReturned(test)

    await test.sendHuman(
      { type: "task-interrupt", taskRequestId: requestId, turnSequence: 42 },
      "human-returned"
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

  it("persists a returning Human's replacement BEFORE interrupting the old turn", async () => {
    const test = harness()
    const requestId = await creatorLeftAndHumanReturned(test)
    const agentSocket = test.connectAgentSocket("agent-a")
    agentSocket.sent.length = 0

    const messagesBefore = test.stored().messages.length
    await test.sendHuman(
      {
        type: "task-interrupt-and-send",
        taskRequestId: requestId,
        turnSequence: 42,
        text: "do it differently",
      },
      "human-returned"
    )

    expect(test.errorFrames()).toEqual([])
    // Exactly ONE canonical replacement instruction, correlated to the Task.
    const messages = test.stored().messages
    expect(messages).toHaveLength(messagesBefore + 1)
    const replacement = messages[messages.length - 1]
    expect(replacement.text).toBe("do it differently")
    expect(replacement.taskRequestId).toBe(requestId)
    // And exactly ONE interrupt of exactly the old live turn.
    expect(test.agentControls("agent-a")).toEqual([
      {
        type: "task-control",
        control: "interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      },
    ])
  })

  it("keeps the original creator able to supervise while still present", async () => {
    const test = harness()
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, 42)

    await test.sendHuman({
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })

    expect(test.errorFrames()).toEqual([])
    expect(test.agentControls("agent-a")).toHaveLength(1)
  })
})

describe("Task supervision security boundaries are unchanged (#421)", () => {
  it("rejects an unauthenticated caller without any control", async () => {
    const test = harness()
    const requestId = await creatorLeftAndHumanReturned(test)
    const intruder = { send: vi.fn(), close: vi.fn() } as unknown as WebSocket

    await test.deliver(
      "human-returned",
      "wrong-token",
      { type: "task-interrupt", taskRequestId: requestId, turnSequence: 42 },
      intruder
    )

    expect(intruder.close).toHaveBeenCalledWith(4003, "Unauthorized")
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("rejects a non-Human caller without any control", async () => {
    const test = harness()
    const requestId = await creatorLeftAndHumanReturned(test)
    const agentCaller = {
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket

    await test.deliver(
      "agent-b",
      "agent-b-token",
      { type: "task-interrupt", taskRequestId: requestId, turnSequence: 42 },
      agentCaller
    )

    expect(agentCaller.close).toHaveBeenCalledWith(4003, "Unauthorized")
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("rejects an unknown Task", async () => {
    const test = harness()
    await creatorLeftAndHumanReturned(test)

    await test.sendHuman(
      {
        type: "task-interrupt",
        taskRequestId: "unknown-task",
        turnSequence: 42,
      },
      "human-returned"
    )

    expect(test.errorFrames()).toEqual(["unknown_task_request"])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("rejects a stale or wrong turn sequence", async () => {
    const test = harness()
    const requestId = await creatorLeftAndHumanReturned(test)

    for (const turnSequence of [41, 43]) {
      await test.sendHuman(
        { type: "task-interrupt", taskRequestId: requestId, turnSequence },
        "human-returned"
      )
    }

    // #421 Fix G: a stale exact turn is a benign control race with a
    // bounded human-readable outcome, never a raw protocol code in the
    // Room-wide failure banner.
    expect(test.errorFrames()).toEqual([])
    expect(test.notices()).toEqual([
      "interrupt_turn_finished",
      "interrupt_turn_finished",
    ])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("rejects a disconnected canonical Agent", async () => {
    const test = harness()
    const requestId = await creatorLeftAndHumanReturned(test)
    test.stored().participants["agent-a"].connected = false

    await test.sendHuman(
      { type: "task-interrupt", taskRequestId: requestId, turnSequence: 42 },
      "human-returned"
    )

    expect(test.errorFrames()).toEqual(["task_target_not_in_room"])
    expect(test.agentControls("agent-a")).toEqual([])
  })

  it("rejects a canonical Agent with no resident socket", async () => {
    const test = harness()
    // agent-a is a connected Room participant but holds NO private resident
    // socket, so no control can be delivered to it.
    const requestId = await createTask(test)
    await test.publishExecution("agent-a", requestId, 42)
    test.expireHuman("human-1")
    test.joinHuman("human-returned")

    await test.sendHuman(
      { type: "task-interrupt", taskRequestId: requestId, turnSequence: 42 },
      "human-returned"
    )

    expect(test.errorFrames()).toEqual(["task_agent_not_reachable"])
  })
})
