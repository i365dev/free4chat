import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function collabRequestId(message: Record<string, unknown> | undefined) {
  const collab = message?.collab
  if (!collab || typeof collab !== "object" || Array.isArray(collab))
    return undefined
  const requestId = (collab as Record<string, unknown>).requestId
  return typeof requestId === "string" ? requestId : undefined
}

function buildStoredRoom() {
  const participant = (id: string, kind: "human" | "agent") => ({
    id,
    name: kind === "agent" ? `Agent ${id}` : `Human ${id}`,
    kind,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `tok-${id}`,
    ...(kind === "human" ? { media: {} } : {}),
  })
  return {
    createdAt: Date.now(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": participant("human-1", "human"),
      "human-2": participant("human-2", "human"),
      "agent-a": participant("agent-a", "agent"),
      "agent-b": participant("agent-b", "agent"),
      "agent-z": participant("agent-z", "agent"),
    },
    messages: [],
    nextMessageSequence: 0,
    meetingNotes: { active: false },
    agentVoice: {},
    liveTranscript: { active: false },
    pendingMediaCleanup: [],
  }
}

function makeRoomSession() {
  const stored = buildStoredRoom()
  const store = new Map<string, unknown>([["room", stored]])
  const browserFrames: string[] = []
  const browserSocket = {
    send: (frame: string) => browserFrames.push(frame),
    close: () => undefined,
  }
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: (tags?: string[]) =>
      tags ? ([] as WebSocket[]) : ([browserSocket] as unknown as WebSocket[]),
    id: {
      name: "permission-test-room",
      toString: () => "permission-test-room",
    },
  }
  const roomSession = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  const control = async (body: Record<string, unknown>) => {
    const response = await roomSession.fetch(
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
  const requestPermission = (
    participantId = "agent-a",
    requestId = "permission-1",
    taskRequestId?: string
  ) =>
    control({
      action: "agent-send-permission",
      participantId,
      token: `tok-${participantId}`,
      request: {
        requestId,
        // A body-supplied agentParticipantId must be ignored by the DO.
        agentParticipantId: "agent-b",
        toolCall: {
          title: "Run command",
          kind: "execute",
          summary: "npm install",
          details: { command: "npm install" },
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        expiresInMs: 60_000,
        ...(taskRequestId === undefined ? {} : { taskRequestId }),
      },
    })
  const sendHuman = async (
    participantId: string,
    message: Record<string, unknown>
  ) => {
    await (
      roomSession as unknown as {
        handleClientMessage: (
          socket: unknown,
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      {
        send: (frame: string) => browserFrames.push(frame),
        close: () => undefined,
      },
      {
        participantId,
        token: `tok-${participantId}`,
        connectionNonce: `nonce-${participantId}`,
      },
      message
    )
  }
  const storedRoom = () =>
    store.get("room") as {
      messages: Array<Record<string, unknown>>
      permissionRequests?: Record<string, Record<string, unknown>>
      nextMessageSequence: number
    }
  const agentWait = async (participantId: string, cursor = 0) =>
    control({
      action: "agent-wait",
      participantId,
      token: `tok-${participantId}`,
      cursor,
      timeoutSeconds: 0,
    })
  const reload = () => new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  return {
    roomSession,
    control,
    requestPermission,
    sendHuman,
    storedRoom,
    agentWait,
    reload,
    browserFrames,
  }
}

describe("RoomSession structured permission lifecycle (#286)", () => {
  it("accepts a bounded Agent request and preserves native option presentation", async () => {
    const room = makeRoomSession()
    const result = await room.requestPermission()

    expect(result.status).toBe(200)
    const message = room.storedRoom().messages[0]!
    expect(message.actionType).toBe("permission")
    expect(message.peerId).toBe("agent-a")
    expect(message.taskRequestId).toBeUndefined()
    expect(message.targets).toEqual(["agent-a"])
    expect(message.permission).toMatchObject({
      requestId: "permission-1",
      kind: "request",
      agentParticipantId: "agent-a",
      toolCall: {
        title: "Run command",
        kind: "execute",
        summary: "npm install",
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    })
  })

  it("keeps Task permission correlation through duplicate, resolution, and expiry", async () => {
    const room = makeRoomSession()
    await room.sendHuman("human-1", {
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Task T",
    })
    const taskRequestId = collabRequestId(room.storedRoom().messages[0])
    if (typeof taskRequestId !== "string")
      throw new Error("Task was not created")

    const first = await room.requestPermission(
      "agent-a",
      "permission-task",
      taskRequestId
    )
    expect(first.status).toBe(200)
    expect(room.storedRoom().messages[1]).toMatchObject({
      taskRequestId,
      permission: { requestId: "permission-task", kind: "request" },
    })
    expect(
      room.storedRoom().permissionRequests?.["permission-task"]
    ).toMatchObject({
      taskRequestId,
    })

    const duplicate = await room.requestPermission(
      "agent-a",
      "permission-task",
      taskRequestId
    )
    expect(duplicate.status).toBe(200)
    expect(duplicate.json.duplicate).toBe(true)

    await room.sendHuman("human-1", {
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Task U",
    })
    const taskURequestId = collabRequestId(room.storedRoom().messages[2])
    if (typeof taskURequestId !== "string")
      throw new Error("Task U was not created")
    const conflict = await room.requestPermission(
      "agent-a",
      "permission-task",
      taskURequestId
    )
    expect(conflict.status).toBe(409)

    await room.sendHuman("human-1", {
      type: "permission-response",
      requestId: "permission-task",
      selectedOptionId: "allow-once",
    })
    expect(room.storedRoom().messages.at(-1)).toMatchObject({
      taskRequestId,
      permission: { requestId: "permission-task", kind: "resolved" },
    })

    const expiry = await room.requestPermission(
      "agent-a",
      "permission-expiry",
      taskRequestId
    )
    expect(expiry.status).toBe(200)
    const pending = room.storedRoom().permissionRequests?.["permission-expiry"]
    ;(pending?.event as Record<string, unknown>).expiresAt = Date.now() - 1
    await room.roomSession.alarm()
    expect(room.storedRoom().messages.at(-1)).toMatchObject({
      taskRequestId,
      permission: { requestId: "permission-expiry", kind: "expired" },
    })
  })

  it("authorizes Task permission for later participating Agents only", async () => {
    const room = makeRoomSession()
    await room.sendHuman("human-1", {
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Task T",
    })
    const taskRequestId = collabRequestId(room.storedRoom().messages[0])
    if (typeof taskRequestId !== "string")
      throw new Error("Task was not created")

    await room.sendHuman("human-1", {
      type: "chat",
      text: "@Agent agent-b review this",
      taskRequestId,
      targets: ["agent-b"],
    })
    const participating = await room.requestPermission(
      "agent-b",
      "permission-agent-b",
      taskRequestId
    )
    expect(participating.status).toBe(200)

    const unrelated = await room.requestPermission(
      "agent-z",
      "permission-agent-z",
      taskRequestId
    )
    expect(unrelated.status).toBe(400)
    expect(unrelated.json.error).toBe("permission_task_participant_mismatch")

    const stale = await room.requestPermission(
      "agent-a",
      "permission-stale-task",
      "unknown-task"
    )
    expect(stale.status).toBe(400)
    expect(stale.json.error).toBe("unknown_task_request")
  })

  it("deduplicates the same request and rejects conflicting reuse", async () => {
    const room = makeRoomSession()
    const first = await room.requestPermission()
    const duplicate = await room.requestPermission()
    const conflict = await room.control({
      action: "agent-send-permission",
      participantId: "agent-a",
      token: "tok-agent-a",
      request: {
        requestId: "permission-1",
        toolCall: { title: "Different command" },
        options: [{ optionId: "other", name: "Other" }],
      },
    })

    expect(first.json.sequence).toBe(duplicate.json.sequence)
    expect(duplicate.json.duplicate).toBe(true)
    expect(conflict.status).toBe(409)
    expect(room.storedRoom().messages).toHaveLength(1)
  })

  it("replays a pending request after its message is evicted from the ring", async () => {
    const room = makeRoomSession()
    await room.requestPermission()
    for (let index = 0; index < 101; index += 1) {
      const result = await room.control({
        action: "agent-send-text",
        participantId: "agent-a",
        token: "tok-agent-a",
        text: `timeline-${index}`,
      })
      expect(result.status).toBe(200)
    }

    expect(
      room
        .storedRoom()
        .messages.some(
          (message) =>
            message.actionType === "permission" &&
            (message.permission as Record<string, unknown> | undefined)
              ?.kind === "request"
        )
    ).toBe(false)

    const retry = await room.requestPermission()
    expect(retry.status).toBe(200)
    expect(retry.json.duplicate).toBe(true)
    const pending = room.storedRoom().permissionRequests?.["permission-1"]
    const replayed = room
      .storedRoom()
      .messages.find(
        (message) =>
          message.actionType === "permission" &&
          (message.permission as Record<string, unknown> | undefined)
            ?.requestId === "permission-1" &&
          (message.permission as Record<string, unknown> | undefined)?.kind ===
            "request"
      )
    expect(replayed).toBeTruthy()
    expect(pending?.sequence).toBe(replayed?.sequence)
    expect(
      room.browserFrames
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .some(
          (frame) =>
            frame.type === "message" &&
            (frame.message as Record<string, unknown> | undefined)?.sequence ===
              replayed?.sequence
        )
    ).toBe(true)

    await room.sendHuman("human-1", {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "allow-once",
    })
    expect(room.storedRoom().permissionRequests).toEqual({})
    expect(room.storedRoom().messages.at(-1)?.permission).toMatchObject({
      requestId: "permission-1",
      kind: "resolved",
      selectedOptionId: "allow-once",
    })
  })

  it("derives the Agent identity from authentication and exposes the request to Humans", async () => {
    const room = makeRoomSession()
    await room.requestPermission()
    await room.sendHuman("human-1", { type: "chat", text: "approved" })

    const requestFrame = room.browserFrames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find(
        (frame) =>
          frame.type === "message" &&
          (frame.message as Record<string, unknown> | undefined)?.actionType ===
            "permission"
      )
    expect(requestFrame).toBeTruthy()
    const messages = room.storedRoom().messages
    expect(messages[0]?.permission).toMatchObject({
      agentParticipantId: "agent-a",
      kind: "request",
    })
    expect(messages.some((message) => message.permission)).toBe(true)
    expect(messages.some((message) => message.text === "approved")).toBe(true)

    const spoofedAgent = await room.control({
      action: "agent-send-permission",
      participantId: "human-1",
      token: "tok-human-1",
      request: {},
    })
    expect(spoofedAgent.status).toBe(403)
  })

  it("accepts a response from any current Human and delivers only the target Agent event", async () => {
    const room = makeRoomSession()
    await room.requestPermission()
    await room.sendHuman("human-2", {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "allow-once",
    })

    const resolved = room.storedRoom().messages[1]!
    expect(resolved.permission).toMatchObject({
      kind: "resolved",
      requestId: "permission-1",
      agentParticipantId: "agent-a",
      selectedOptionId: "allow-once",
      humanParticipantId: "human-2",
      humanName: "Human human-2",
    })
    expect(room.storedRoom().permissionRequests).toEqual({})

    const target = await room.agentWait("agent-a")
    const targetEvent = (
      target.json.events as Array<Record<string, unknown>>
    ).find(
      (event) =>
        (event.permission as Record<string, unknown> | undefined)?.kind ===
        "resolved"
    )
    expect(targetEvent?.addressed).toBe(true)
    expect(
      (targetEvent?.permission as Record<string, unknown> | undefined)
        ?.selectedOptionId
    ).toBe("allow-once")

    const unrelated = await room.agentWait("agent-b")
    expect(
      (unrelated.json.events as Array<Record<string, unknown>>).some(
        (event) => event.actionType === "permission"
      )
    ).toBe(false)
  })

  it("rejects nonexistent options, makes first valid response win, and blocks Agent resolution", async () => {
    const room = makeRoomSession()
    await room.requestPermission()
    await room.sendHuman("human-1", {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "missing",
    })
    expect(room.storedRoom().messages).toHaveLength(1)

    const closed: string[] = []
    await (
      room.roomSession as unknown as {
        handleClientMessage: (
          socket: unknown,
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      {
        send: (frame: string) => closed.push(frame),
        close: (code: number) => closed.push(`closed:${code}`),
      },
      { participantId: "agent-a", token: "tok-agent-a" },
      {
        type: "permission-response",
        requestId: "permission-1",
        selectedOptionId: "allow-once",
      }
    )
    expect(closed.join(" ")).toContain("closed:4003")
    await room.sendHuman("human-1", {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "allow-once",
    })
    await room.sendHuman("human-2", {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "deny",
    })
    expect(room.storedRoom().messages).toHaveLength(2)
    expect(room.storedRoom().messages[1]?.permission).toMatchObject({
      selectedOptionId: "allow-once",
    })
  })

  it("does not let ordinary action/text messages resolve a permission request", async () => {
    const room = makeRoomSession()
    await room.requestPermission()
    const actionFrames: string[] = []
    await (
      room.roomSession as unknown as {
        handleClientMessage: (
          socket: unknown,
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      {
        send: (frame: string) => actionFrames.push(frame),
        close: () => undefined,
      },
      { participantId: "human-1", token: "tok-human-1" },
      {
        type: "action",
        actionType: "permission",
        actionPayload: { requestId: "permission-1", selectedOptionId: "deny" },
      }
    )
    expect(actionFrames.join(" ")).toContain(
      "permission_requires_structured_response"
    )
    expect(room.storedRoom().permissionRequests).toHaveProperty("permission-1")
  })

  it("expires pending requests on Agent departure and on the bounded alarm deadline", async () => {
    const leavingRoom = makeRoomSession()
    await leavingRoom.requestPermission()
    const left = await leavingRoom.control({
      action: "agent-leave",
      participantId: "agent-a",
      token: "tok-agent-a",
    })
    expect(left.status).toBe(200)
    expect(leavingRoom.storedRoom().permissionRequests).toEqual({})
    expect(leavingRoom.storedRoom().messages[1]?.permission).toMatchObject({
      kind: "expired",
      agentParticipantId: "agent-a",
    })

    const expiringRoom = makeRoomSession()
    await expiringRoom.requestPermission()
    const stored = expiringRoom.storedRoom()
    const pending = stored.permissionRequests?.["permission-1"]
    const event = pending?.event as Record<string, unknown>
    event.expiresAt = Date.now() - 1
    await expiringRoom.roomSession.alarm()
    expect(expiringRoom.storedRoom().permissionRequests).toEqual({})
    expect(expiringRoom.storedRoom().messages[1]?.permission).toMatchObject({
      kind: "expired",
    })
  })

  it("commits expiry discovered by a rejected Human response", async () => {
    const room = makeRoomSession()
    await room.requestPermission()
    const pending = room.storedRoom().permissionRequests?.["permission-1"]
    ;(pending?.event as Record<string, unknown>).expiresAt = Date.now() - 1

    await room.sendHuman("human-1", {
      type: "permission-response",
      requestId: "permission-1",
      selectedOptionId: "allow-once",
    })

    const errors = room.browserFrames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame.type === "error")
    expect(errors.at(-1)).toMatchObject({
      type: "error",
      error: "permission_request_expired",
    })
    const states = room.browserFrames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame.type === "state")
    const stateMessages = ((states.at(-1)?.state as Record<string, unknown>)
      ?.messages ?? []) as Array<Record<string, unknown>>
    expect(stateMessages).toContainEqual(
      expect.objectContaining({
        permission: expect.objectContaining({
          requestId: "permission-1",
          kind: "expired",
        }),
      })
    )

    const target = await room.agentWait("agent-a")
    expect(target.json.events).toContainEqual(
      expect.objectContaining({
        addressed: true,
        permission: expect.objectContaining({
          requestId: "permission-1",
          kind: "expired",
        }),
      })
    )

    const reloaded = room.reload()
    const durable = await (
      reloaded as unknown as {
        loadRoom: () => Promise<{
          permissionRequests?: Record<string, unknown>
          messages: Array<Record<string, unknown>>
        } | null>
      }
    ).loadRoom()
    expect(durable?.permissionRequests).toEqual({})
    expect(durable?.messages).toContainEqual(
      expect.objectContaining({
        actionType: "permission",
        permission: expect.objectContaining({
          requestId: "permission-1",
          kind: "expired",
        }),
      })
    )
  })
})
