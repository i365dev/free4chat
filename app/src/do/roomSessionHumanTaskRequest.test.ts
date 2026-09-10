import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import { buildTaskProjectionIndex } from "./taskScope"
import type { RoomRecord } from "../room/types"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function human(): RoomRecord["participants"][string] {
  return {
    id: "human-1",
    name: "Guest",
    kind: "human",
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: "human-token",
    media: {
      sessionId: "human-session",
      muted: false,
      fileChannelReady: true,
      tracks: [{ trackName: "mic", kind: "audio" }],
    },
  }
}

function agent(id: string) {
  return {
    id,
    name: id === "agent-a" ? "Resident Agent" : "Other Agent",
    kind: "agent" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
  }
}

function room(): RoomRecord {
  return {
    createdAt: 1,
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": human(),
      "agent-a": agent("agent-a"),
      "agent-b": agent("agent-b"),
      "agent-c": agent("agent-c"),
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
  const socket = { send: vi.fn(), close: vi.fn() } as unknown as WebSocket
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [] as WebSocket[],
  }
  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  const sendHuman = (message: unknown) =>
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
        participantId: "human-1",
        token: "human-token",
        connectionNonce: "human-connection",
      },
      message
    )
  return {
    session,
    socket,
    sendHuman,
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
    stored: () => store.get("room") as RoomRecord,
    taskProjection: () => {
      const stored = store.get("room") as RoomRecord
      return buildTaskProjectionIndex(stored.messages, stored.participants)
    },
  }
}

describe("RoomSession Human task entry (#305)", () => {
  it("uses the authenticated Human, validates the chosen Agent, and projects a server requestId to task scope", async () => {
    const test = harness()

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Use TASK_T_MARKER",
    })

    const message = test.stored().messages[0]
    expect(message).toMatchObject({
      peerId: "human-1",
      targets: ["agent-a"],
      collab: {
        kind: "request",
        fromParticipantId: "human-1",
        targetParticipantId: "agent-a",
        summary: "Use TASK_T_MARKER",
      },
    })
    const requestId = message.collab?.requestId
    expect(requestId).toEqual(expect.any(String))
    expect(message.collab?.requestId).not.toBe("browser-request-id")

    const event = (
      test.session as unknown as {
        toAgentEvent: (
          message: unknown,
          participantId: string,
          projection: ReturnType<typeof buildTaskProjectionIndex>
        ) => {
          scopeId?: string
          addressed: boolean
        }
      }
    ).toAgentEvent(message, "agent-a", test.taskProjection())
    expect(event).toMatchObject({
      scopeId: `task:${requestId}`,
      addressed: true,
    })

    // The other connected Agent does not receive the task scope, and the
    // canonical Room target remains only the selected Agent.
    expect(
      (
        test.session as unknown as {
          toAgentEvent: (
            message: unknown,
            participantId: string,
            projection: ReturnType<typeof buildTaskProjectionIndex>
          ) => {
            scopeId?: string
          }
        }
      ).toAgentEvent(message, "agent-b", test.taskProjection())?.scopeId
    ).toBeUndefined()
    expect(message.targets).toEqual(["agent-a"])

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Use TASK_U_MARKER",
    })
    const second = test.stored().messages[1]
    expect(second.collab?.summary).toBe("Use TASK_U_MARKER")
    expect(second.collab?.requestId).not.toBe(requestId)
    expect(
      (
        test.session as unknown as {
          toAgentEvent: (
            message: unknown,
            participantId: string,
            projection: ReturnType<typeof buildTaskProjectionIndex>
          ) => {
            scopeId?: string
          }
        }
      ).toAgentEvent(second, "agent-a", test.taskProjection())?.scopeId
    ).toBe(`task:${second.collab?.requestId}`)
  })

  it("rejects a Human or disconnected participant as the task target", async () => {
    const test = harness()

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "human-1",
      summary: "not an Agent",
    })
    expect(
      JSON.parse(
        (test.socket.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      )
    ).toEqual({
      type: "error",
      error: "target_not_agent",
    })
    expect(test.stored().messages).toHaveLength(0)

    test.stored().participants["agent-a"].connected = false
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "stale target",
    })
    expect(
      JSON.parse(
        (test.socket.send as ReturnType<typeof vi.fn>).mock.calls[1][0]
      )
    ).toEqual({
      type: "error",
      error: "target_not_in_room",
    })
    expect(test.stored().messages).toHaveLength(0)
  })

  it("keeps Agent output and Human follow-up in the existing task interaction", async () => {
    const test = harness()

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Investigate the task marker",
    })
    const requestId = test.stored().messages[0].collab?.requestId
    expect(requestId).toEqual(expect.any(String))

    const agentReply = await test.control({
      action: "agent-send-text",
      participantId: "agent-a",
      token: "agent-a-token",
      text: "task agent output",
      taskRequestId: requestId,
    })
    expect(agentReply.status).toBe(200)
    expect(test.stored().messages[1]).toMatchObject({
      text: "task agent output",
      taskRequestId: requestId,
    })

    await test.sendHuman({
      type: "chat",
      text: "task human follow-up",
      taskRequestId: requestId,
    })
    expect(test.stored().messages[2]).toMatchObject({
      peerId: "human-1",
      text: "task human follow-up",
      taskRequestId: requestId,
      targets: ["agent-a"],
    })

    const agentEvent = (
      test.session as unknown as {
        toAgentEvent: (
          message: unknown,
          participantId: string,
          projection: ReturnType<typeof buildTaskProjectionIndex>
        ) => { scopeId?: string; addressed: boolean } | undefined
      }
    ).toAgentEvent(test.stored().messages[2], "agent-a", test.taskProjection())
    expect(agentEvent).toMatchObject({
      scopeId: `task:${requestId}`,
      addressed: true,
    })
  })

  it("allows a Human to explicitly add another Agent to an existing Task", async () => {
    const test = harness()

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Bring another reviewer into the task",
    })
    const requestId = test.stored().messages[0].collab?.requestId
    expect(requestId).toEqual(expect.any(String))

    await test.sendHuman({
      type: "chat",
      text: "@Other Agent please review this",
      targets: ["agent-b"],
      taskRequestId: requestId,
    })
    const message = test.stored().messages[1]
    expect(message).toMatchObject({
      taskRequestId: requestId,
      targets: ["agent-b"],
    })

    const projection = test.taskProjection()
    const project = (participantId: string) =>
      (
        test.session as unknown as {
          toAgentEvent: (
            message: unknown,
            participantId: string,
            projection: ReturnType<typeof buildTaskProjectionIndex>
          ) => { scopeId?: string; addressed: boolean } | undefined
        }
      ).toAgentEvent(message, participantId, projection)
    expect(project("agent-a")).toMatchObject({
      scopeId: `task:${requestId}`,
      addressed: false,
    })
    expect(project("agent-b")).toMatchObject({
      scopeId: `task:${requestId}`,
      addressed: true,
    })
    expect(project("agent-c")).toBeUndefined()
  })

  it("keeps unrelated Agents out of live and retained Task context", async () => {
    const test = harness()
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Keep this context scoped",
    })
    const requestId = test.stored().messages[0].collab?.requestId

    const wait = async (participantId: string, cursor = 0) =>
      test.control({
        action: "agent-wait",
        participantId,
        token: `${participantId}-token`,
        cursor,
        timeoutSeconds: 0,
      })
    const read = async (participantId: string) =>
      test.control({
        action: "agent-read-context",
        participantId,
        token: `${participantId}-token`,
        afterSequence: 0,
        limit: 50,
      })

    const unrelatedBefore = await wait("agent-c")
    expect(unrelatedBefore.json.events).toEqual([])
    expect((await read("agent-c")).json.events).toEqual([])

    await test.sendHuman({
      type: "chat",
      text: "@Other Agent join this task",
      targets: ["agent-b"],
      taskRequestId: requestId,
    })
    const newlyTargeted = await wait("agent-b", 1)
    expect(newlyTargeted.json.events).toHaveLength(1)
    expect(newlyTargeted.json.events[0]).toMatchObject({
      scopeId: `task:${requestId}`,
      addressed: true,
    })
    expect(
      ((await read("agent-b")).json.events as Array<{ scopeId?: string }>).map(
        (event: { scopeId?: string }) => event.scopeId
      )
    ).toEqual([`task:${requestId}`, `task:${requestId}`])
    expect((await wait("agent-c", 1)).json.events).toEqual([])
    expect((await read("agent-c")).json.events).toEqual([])
  })

  it("rejects invalid explicit Human Task targets without fallback", async () => {
    const test = harness()
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Validate targets",
    })
    const requestId = test.stored().messages[0].collab?.requestId

    for (const target of ["human-1", "missing", "agent-b"]) {
      if (target === "agent-b")
        test.stored().participants[target].connected = false
      await test.sendHuman({
        type: "chat",
        text: "must reject",
        targets: [target],
        taskRequestId: requestId,
      })
    }

    expect(test.stored().messages).toHaveLength(1)
    expect(test.socket.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: "error", error: "task_target_not_agent" })
    )
    expect(test.socket.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: "error", error: "task_target_not_in_room" })
    )
    expect(test.socket.send).toHaveBeenNthCalledWith(
      3,
      JSON.stringify({ type: "error", error: "task_target_not_in_room" })
    )
  })

  it("rejects arbitrary task correlation instead of creating a task view", async () => {
    const test = harness()

    await test.sendHuman({
      type: "chat",
      text: "forged task text",
      taskRequestId: "not-a-canonical-request",
    })

    expect(test.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", error: "unknown_task_request" })
    )
    expect(test.stored().messages).toHaveLength(0)
  })
})
