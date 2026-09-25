import { afterEach, describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

/**
 * #346 TaskControlUsed.
 *
 * ONE low-frequency event answering "are Humans actually using the
 * supervision controls Free4Chat shipped?", emitted ONLY after the canonical
 * Room action is accepted and performed. These tests pin the success
 * boundary for every implemented control, and the negative cases that must
 * stay silent: malformed requests, wrong/stale turns, unknown Tasks,
 * unauthorized callers, failed operations, and deduplicated replays.
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

function agent(id: string, continuation = false) {
  return {
    id,
    name: id,
    kind: "agent" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    connectionNonce: `${id}-nonce`,
    ...(continuation
      ? { runtimeFeatures: { taskSessionContinuation: true } }
      : {}),
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
      "agent-a": agent("agent-a", true),
      "agent-b": agent("agent-b", true),
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

function harness(options: { analyticsFails?: boolean } = {}) {
  const store = new Map<string, unknown>([["room", room()]])
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  const humanSockets = new Map<string, FakeSocket>()
  const agentSockets = new Map<string, FakeSocket>()

  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
      },
      deleteAll: async () => void store.clear(),
      list: async (listOptions: { prefix: string }) =>
        new Map(
          [...store.entries()].filter(([key]) =>
            key.startsWith(listOptions.prefix)
          )
        ),
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
    waitUntil: (promise: Promise<unknown>) => void promise,
    id: { name: "test-room", toString: () => "test-room" },
  }
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} })
    if (String(url).includes("api.mixpanel.com")) {
      if (options.analyticsFails)
        return Promise.reject(new Error("analytics unavailable"))
      return Promise.resolve(new Response("{}", { status: 200 }))
    }
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

  const webSocketMessage = (socket: FakeSocket, message: unknown) =>
    (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(socket as unknown as WebSocket, JSON.stringify(message))

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

  return {
    session,
    store,
    fetchCalls,
    control,
    connectHuman: (participantId: string): FakeSocket => {
      const socket = makeSocket(undefined, {
        participantId,
        token: `${participantId}-token`,
        connectionNonce: `${participantId}-connection`,
      })
      humanSockets.set(participantId, socket)
      return socket
    },
    connectAgentSocket: (participantId: string): FakeSocket => {
      const socket = makeSocket(`agent-event:${participantId}`, {
        kind: "agent-event",
        participantId,
        connectionNonce: `${participantId}-nonce`,
        cursor: 0,
      })
      agentSockets.set(participantId, socket)
      return socket
    },
    sendHuman: (socket: FakeSocket, message: unknown) =>
      webSocketMessage(socket, message),
    sendAgent: (socket: FakeSocket, message: unknown) =>
      webSocketMessage(socket, message),
    sendAsParticipant: (
      socket: FakeSocket,
      participantId: string,
      message: unknown
    ) => {
      humanSockets.set(participantId, socket)
      return webSocketMessage(socket, message)
    },
    stored: () => store.get("room") as RoomRecord,
    /** Publish the authoritative exact-turn Task execution projection. */
    publishExecution: async (
      participantId: string,
      taskRequestId: string,
      currentTurnSequence: number
    ) =>
      control({
        action: "agent-task-execution",
        participantId,
        token: `${participantId}-token`,
        projection: {
          taskRequestId,
          queuedCount: 0,
          currentTurnSequence,
          phase: "running",
        },
      }),
  }
}

/** Creates one canonical Human -> Agent Task and returns its requestId. */
async function createTask(
  test: ReturnType<typeof harness>,
  humanSocket: FakeSocket,
  targetParticipantId = "agent-a"
): Promise<string> {
  await test.sendHuman(humanSocket, {
    type: "collab-request",
    targetParticipantId,
    summary: "Run a long task",
  })
  const requestId = test.stored().messages[0]?.collab?.requestId
  if (!requestId) throw new Error("canonical Task request was not created")
  return requestId
}

function controlEvents(
  calls: Array<{ url: string; init: RequestInit }>,
  control: string
) {
  return calls
    .filter((call) => call.url.includes("api.mixpanel.com"))
    .map((call) => JSON.parse(call.init.body as string))
    .flat()
    .filter(
      (row: { event: string; properties: Record<string, unknown> }) =>
        row.event === "TaskControlUsed" && row.properties.control === control
    )
}

function allControlEvents(calls: Array<{ url: string; init: RequestInit }>) {
  return calls
    .filter((call) => call.url.includes("api.mixpanel.com"))
    .map((call) => JSON.parse(call.init.body as string))
    .flat()
    .filter((row: { event: string }) => row.event === "TaskControlUsed")
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("TaskControlUsed — interrupt (#346)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("emits exactly one 'interrupt' for an accepted canonical interrupt", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)

    await test.sendHuman(humanSocket, {
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    await flushMicrotasks()

    const events = controlEvents(test.fetchCalls, "interrupt")
    expect(events).toHaveLength(1)
    const properties = events[0].properties
    expect(properties.analyticsRoomId).toBe(test.stored().analyticsRoomId)
    expect(properties.roomHash).toBeTruthy()
    expect(properties.roomComposition).toBe("mixed")
    // No Task, turn, participant, or content value ever rides — the whole
    // /import row is checked, envelope fields included.
    const serialized = JSON.stringify(events[0])
    expect(serialized).not.toContain(requestId)
    expect(serialized).not.toContain("agent-a")
    expect(serialized).not.toContain("human-1")
    expect(serialized).not.toContain("Run a long task")
    expect(serialized).not.toContain("test-room")
    expect(serialized).not.toContain("turnSequence")
    expect(serialized).not.toContain('"42"')
    expect(
      Object.keys(properties)
        .filter(
          (key) => !["time", "distinct_id", "$insert_id", "ip"].includes(key)
        )
        .sort()
    ).toEqual([
      "analyticsRoomId",
      "control",
      "roomComposition",
      "roomHash",
      "roomType",
    ])
  })

  it("emits nothing for a stale turn, an unknown Task, or a malformed request", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)

    // Stale/incorrect turn: a benign control race, not an accepted control.
    await test.sendHuman(humanSocket, {
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 41,
    })
    // Unknown Task.
    await test.sendHuman(humanSocket, {
      type: "task-interrupt",
      taskRequestId: "task-does-not-exist",
      turnSequence: 42,
    })
    // Malformed request.
    await test.sendHuman(humanSocket, {
      type: "task-interrupt",
      taskRequestId: "",
      turnSequence: "not-a-turn",
    })
    await flushMicrotasks()

    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })

  it("emits nothing when the canonical Agent endpoint is unreachable", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    // No resident Agent socket: the control cannot land, so it is not a use.
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)

    await test.sendHuman(humanSocket, {
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    await flushMicrotasks()

    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })

  it("emits nothing for an unauthorized (non-Human) caller", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)

    const agentSocket = makeSocket(undefined, {
      participantId: "agent-a",
      token: "agent-a-token",
      connectionNonce: "agent-a-connection",
    })
    await test.sendAsParticipant(agentSocket, "agent-a", {
      type: "task-interrupt",
      taskRequestId: requestId,
      turnSequence: 42,
    })
    await flushMicrotasks()

    expect(agentSocket.close).toHaveBeenCalledWith(4003, "Unauthorized")
    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })
})

describe("TaskControlUsed — interrupt & send (#346)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("emits one 'interrupt-send' (and never also 'interrupt') on success", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)

    await test.sendHuman(humanSocket, {
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "please use a different approach",
    })
    await flushMicrotasks()

    expect(controlEvents(test.fetchCalls, "interrupt-send")).toHaveLength(1)
    expect(controlEvents(test.fetchCalls, "interrupt")).toHaveLength(0)
    // The redirected instruction text is never part of the event.
    expect(JSON.stringify(allControlEvents(test.fetchCalls))).not.toContain(
      "different approach"
    )
  })

  it("emits nothing when the turn finished first and no interrupt landed", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)
    // The Task moved on before the interrupt was dispatched.
    await test.publishExecution("agent-a", requestId, 43)

    await test.sendHuman(humanSocket, {
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "too late",
    })
    await flushMicrotasks()

    // The instruction is durably queued (product behavior unchanged), but no
    // supervision control was used.
    expect(test.stored().messages).toHaveLength(2)
    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })

  it("emits nothing when the interrupt cannot be delivered", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)

    await test.sendHuman(humanSocket, {
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "no resident socket",
    })
    await flushMicrotasks()

    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })

  it("emits nothing for an empty instruction", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    test.connectAgentSocket("agent-a")
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)

    await test.sendHuman(humanSocket, {
      type: "task-interrupt-and-send",
      taskRequestId: requestId,
      turnSequence: 42,
      text: "   ",
    })
    await flushMicrotasks()

    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })
})

describe("TaskControlUsed — permission resolution (#346)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * One canonical Human -> Agent Task, so a permission can be genuinely
   * Task-scoped exactly as the resident Runtime correlates it.
   */
  async function createCanonicalTask(
    test: ReturnType<typeof harness>,
    humanSocket: FakeSocket
  ) {
    return createTask(test, humanSocket)
  }

  async function pendingPermission(
    test: ReturnType<typeof harness>,
    options: Array<Record<string, unknown>>,
    options2: { participantId?: string; taskRequestId?: string } = {}
  ) {
    const participantId = options2.participantId ?? "agent-a"
    const result = await test.control({
      action: "agent-send-permission",
      participantId,
      token: `${participantId}-token`,
      request: {
        requestId: "permission-1",
        toolCall: { title: "Run command", kind: "execute" },
        options,
        expiresInMs: 60_000,
        ...(options2.taskRequestId === undefined
          ? {}
          : { taskRequestId: options2.taskRequestId }),
      },
    })
    expect(result.status).toBe(200)
  }

  it("maps the stable ACP option kind, never the display name or option id", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const taskRequestId = await createCanonicalTask(test, humanSocket)
    // Deliberately misleading presentation: the NAME says Allow, the
    // protocol-level kind says reject.
    await pendingPermission(
      test,
      [
        { optionId: "opaque-a", name: "Allow", kind: "reject_once" },
        { optionId: "opaque-b", name: "Deny", kind: "allow_once" },
      ],
      { taskRequestId }
    )

    await test.sendHuman(humanSocket, {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "opaque-a",
    })
    await flushMicrotasks()

    expect(controlEvents(test.fetchCalls, "permission-reject")).toHaveLength(1)
    expect(controlEvents(test.fetchCalls, "permission-allow")).toHaveLength(0)
    const serialized = JSON.stringify(allControlEvents(test.fetchCalls))
    expect(serialized).not.toContain("opaque-a")
    expect(serialized).not.toContain("Allow")
    expect(serialized).not.toContain("permission-1")
  })

  it("degenerates to one coarse value when the Room has no protocol-level kind", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const taskRequestId = await createCanonicalTask(test, humanSocket)
    await pendingPermission(test, [{ optionId: "opaque-a", name: "Approve" }], {
      taskRequestId,
    })

    await test.sendHuman(humanSocket, {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "opaque-a",
    })
    await flushMicrotasks()

    expect(controlEvents(test.fetchCalls, "permission-response")).toHaveLength(
      1
    )
  })

  it("emits nothing for an invalid, unknown, or replayed resolution", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const taskRequestId = await createCanonicalTask(test, humanSocket)
    await pendingPermission(
      test,
      [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      { taskRequestId }
    )

    // Unknown request.
    await test.sendHuman(humanSocket, {
      type: "permission-response",
      requestId: "permission-unknown",
      selectedOptionId: "allow-once",
    })
    // Option that was never offered.
    await test.sendHuman(humanSocket, {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "not-an-option",
    })
    // Malformed.
    await test.sendHuman(humanSocket, {
      type: "permission-response",
      requestId: "",
      selectedOptionId: "",
    })
    await flushMicrotasks()
    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)

    // The one genuine resolution counts exactly once...
    await test.sendHuman(humanSocket, {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "allow-once",
    })
    await flushMicrotasks()
    expect(controlEvents(test.fetchCalls, "permission-allow")).toHaveLength(1)

    // ...and a duplicate replay cannot inflate it.
    await test.sendHuman(humanSocket, {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "allow-once",
    })
    await flushMicrotasks()
    expect(controlEvents(test.fetchCalls, "permission-allow")).toHaveLength(1)
  })

  it("emits NOTHING for an ordinary Room conversation permission", async () => {
    // PermissionRequestRecord.taskRequestId is optional: a permission raised
    // by ordinary Room conversation has no Task correlation at all. Counted
    // as supervision it would dilute the metric with unrelated approvals, so
    // it must stay silent.
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    await pendingPermission(test, [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    ])

    await test.sendHuman(humanSocket, {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "allow-once",
    })
    await flushMicrotasks()

    // The canonical request and resolution still happened, uncorrelated...
    const messages = test.stored().messages
    expect(messages.map((message) => message.actionType)).toEqual([
      "permission",
      "permission",
    ])
    expect(messages[0].permission?.kind).toBe("request")
    expect(messages[1].permission?.kind).toBe("resolved")
    for (const message of messages)
      expect(message.taskRequestId).toBeUndefined()
    // ...but no Task supervision was used.
    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })

  it("emits nothing for a non-Human responder", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const taskRequestId = await createCanonicalTask(test, humanSocket)
    await pendingPermission(
      test,
      [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      { taskRequestId }
    )
    const agentSocket = makeSocket(undefined, {
      participantId: "agent-b",
      token: "agent-b-token",
      connectionNonce: "agent-b-connection",
    })
    await test.sendAsParticipant(agentSocket, "agent-b", {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "allow-once",
    })
    await flushMicrotasks()

    expect(agentSocket.close).toHaveBeenCalledWith(4003, "Unauthorized")
    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })
})

describe("TaskControlUsed — session continuation (#346)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function pendingControlRequestId(socket: FakeSocket): string {
    const attachment = socket.attachment() as {
      pendingSessionControl?: { requestId?: string }
    }
    const requestId = attachment?.pendingSessionControl?.requestId
    if (!requestId) throw new Error("no pending session control")
    return requestId
  }

  it("counts only the continuation whose canonical Task was actually created", async () => {
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
    // Nothing is counted merely because the UI asked.
    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
    expect(humanSocket.sent.map((f) => JSON.parse(f))).toEqual([])
    expect(agentSocket.sent.map((f) => JSON.parse(f))).toHaveLength(1)

    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "prepare",
      requestId: pendingControlRequestId(agentSocket),
      ok: true,
    })
    await flushMicrotasks()

    expect(test.stored().messages).toHaveLength(1)
    expect(
      humanSocket.sent
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .filter((frame) => frame.type === "task-session-start-result")
    ).toEqual([
      { type: "task-session-start-result", requestId: "browser-1", ok: true },
    ])
    const events = controlEvents(test.fetchCalls, "session-continue")
    expect(events).toHaveLength(1)
    const serialized = JSON.stringify(events[0])
    expect(serialized).not.toContain("session-token-1")
    expect(serialized).not.toContain("browser-1")
    expect(serialized).not.toContain("Continue this conversation")
  })

  it("emits nothing when the Runtime refuses the continuation", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")

    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-2",
      targetParticipantId: "agent-a",
      sessionToken: "session-token-2",
      summary: "Continue this conversation",
    })
    await test.sendAgent(agentSocket, {
      type: "task-session-result",
      operation: "prepare",
      requestId: pendingControlRequestId(agentSocket),
      ok: false,
      error: "session_continuation_unavailable",
    })
    await flushMicrotasks()

    expect(test.stored().messages).toHaveLength(0)
    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })

  it("emits nothing for an unsupported Agent or an invalid session control", async () => {
    const test = harness()
    const humanSocket = test.connectHuman("human-1")

    // agent-b advertises only the default feature projection.
    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-3",
      targetParticipantId: "agent-b",
      sessionToken: "session-token-3",
      summary: "Continue this conversation",
    })
    // Missing session token.
    await test.sendHuman(humanSocket, {
      type: "task-session-start",
      requestId: "browser-4",
      targetParticipantId: "agent-a",
      summary: "Continue this conversation",
    })
    await flushMicrotasks()

    expect(allControlEvents(test.fetchCalls)).toHaveLength(0)
  })
})

describe("TaskControlUsed — analytics failure (#346)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("never fails or delays the canonical Room action it observes", async () => {
    const test = harness({ analyticsFails: true })
    const humanSocket = test.connectHuman("human-1")
    const agentSocket = test.connectAgentSocket("agent-a")
    const requestId = await createTask(test, humanSocket)
    await test.publishExecution("agent-a", requestId, 42)

    await expect(
      test.sendHuman(humanSocket, {
        type: "task-interrupt",
        taskRequestId: requestId,
        turnSequence: 42,
      })
    ).resolves.toBeUndefined()

    // The canonical control still landed on the resident socket.
    const controls = agentSocket.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .filter((frame) => frame.type === "task-control")
    expect(controls.some((frame) => frame.control === "interrupt")).toBe(true)
    expect(agentSocket.close).not.toHaveBeenCalled()
  })
})
