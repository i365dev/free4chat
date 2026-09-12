import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

/**
 * #363 A2: a Human may attach into an ACTIVE Task through the existing
 * bounded Room attachment store. The canonical Task correlation is resolved
 * server-side and fails closed — unknown/expired Tasks or a Task with no
 * participating Agent in the Room are rejected before any bytes are stored,
 * and nothing is ever silently downgraded to ordinary Room scope.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function buildStoredRoom(): RoomRecord {
  return {
    createdAt: Date.now(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": {
        id: "human-1",
        name: "Hannah",
        kind: "human",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-human",
      },
      "agent-a": {
        id: "agent-a",
        name: "Agent A",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-agent-a",
        capabilities: { text: true },
      },
      "agent-b": {
        id: "agent-b",
        name: "Agent B",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-agent-b",
        capabilities: { text: true },
      },
    },
    messages: [
      {
        id: "task-request-1",
        peerId: "human-1",
        name: "Hannah",
        kind: "human",
        type: "action",
        actionType: "collab",
        sequence: 1,
        createdAt: 1,
        collab: {
          requestId: "task-1",
          kind: "request",
          fromParticipantId: "human-1",
          targetParticipantId: "agent-a",
          summary: "Review the attached log",
        },
        targets: ["agent-a"],
      },
    ],
    nextMessageSequence: 1,
    attachments: [],
    meetingNotes: { active: false },
    agentVoice: {},
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    nextLiveTranscriptEpoch: 1,
    nextTranscriptSequence: 1,
    pendingMediaCleanup: [],
  }
}

function makeRoom() {
  const store = new Map<string, unknown>([["room", buildStoredRoom()]])
  const broadcasts: Array<Record<string, unknown>> = []
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string | string[]) => {
        for (const candidate of Array.isArray(key) ? key : [key])
          store.delete(candidate)
      },
      list: async (options?: { prefix?: string }) => {
        const entries = [...store.entries()].filter(([key]) =>
          options?.prefix ? key.startsWith(options.prefix) : true
        )
        return new Map(entries)
      },
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => {
      const socket = {
        send: (raw: string) =>
          broadcasts.push(JSON.parse(raw) as Record<string, unknown>),
        close: () => undefined,
      } as unknown as WebSocket
      return [socket]
    },
    waitUntil: (promise: Promise<unknown>) => void promise,
    id: { name: "test-room", toString: () => "test-room" },
  }
  const session = new RoomSession(
    ctx as never,
    { SFU_ROOM: {}, AGENT_MEDIA_ENABLED: "true" } as never
  )
  const upload = (
    sender: { id: string; token: string },
    body = "task context",
    options: { taskRequestId?: string; contentType?: string } = {}
  ) =>
    session.fetch(
      new Request("https://room/attachment", {
        method: "POST",
        headers: {
          "Content-Type": options.contentType ?? "text/plain",
          "Content-Length": String(body.length),
          "X-Room-Participant-Id": sender.id,
          "X-Room-Participant-Token": sender.token,
          "X-File-Name": "context.txt",
          ...(options.taskRequestId
            ? { "X-Task-Request-Id": options.taskRequestId }
            : {}),
        },
        body,
      })
    )
  const control = async (body: Record<string, unknown>) => {
    const response = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
    return { status: response.status, json: await response.json() }
  }
  const room = () => store.get("room") as RoomRecord
  return { session, upload, control, room, broadcasts, store }
}

async function readAttachment(
  session: RoomSession,
  participantId: string,
  token: string,
  attachmentId: string
) {
  const response = await session.fetch(
    new Request("https://room/control", {
      method: "POST",
      body: JSON.stringify({
        action: "agent-read-attachment",
        participantId,
        token,
        attachmentId,
      }),
    })
  )
  return response.status
}

describe("Human Task attachments (#363 A2)", () => {
  it("stores a Human attachment with the exact Task correlation", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "task context",
      { taskRequestId: "task-1" }
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      attachment: {
        id: string
        senderKind: string
        taskRequestId?: string
        size: number
      }
    }
    expect(payload.attachment.senderKind).toBe("human")
    expect(payload.attachment.taskRequestId).toBe("task-1")
    expect(payload.attachment.size).toBe("task context".length)

    const stored = test.room().attachments
    expect(stored).toHaveLength(1)
    expect(stored[0].taskRequestId).toBe("task-1")
    // The browser projection carries the correlation, which is what keeps the
    // item inside its own Task interaction.
    expect(test.broadcasts.at(-1)).toMatchObject({
      type: "attachment",
      attachment: { taskRequestId: "task-1", senderKind: "human" },
    })
  })

  it("keeps the Task attachment readable by the participating Agent through the existing path", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "task context",
      { taskRequestId: "task-1" }
    )
    const payload = (await response.json()) as { attachment: { id: string } }

    // The participating Agent can consume it; an unrelated Agent cannot.
    expect(
      await readAttachment(
        test.session,
        "agent-a",
        "tok-agent-a",
        payload.attachment.id
      )
    ).toBe(200)
    expect(
      await readAttachment(
        test.session,
        "agent-b",
        "tok-agent-b",
        payload.attachment.id
      )
    ).toBe(404)
  })

  it("fails closed for an unknown or expired Task correlation", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "task context",
      { taskRequestId: "task-missing" }
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: "unknown_task_request",
    })
    // No bytes and no metadata were stored, and it never became Room scope.
    expect(test.room().attachments).toHaveLength(0)
    expect(
      [...test.store.keys()].filter((key) => key.startsWith("attachment:"))
    ).toHaveLength(0)
  })

  it("fails closed when the Task has no participating Agent in the Room", async () => {
    const test = makeRoom()
    const room = test.room()
    room.participants["agent-a"] = {
      ...room.participants["agent-a"],
      connected: false,
    }
    test.store.set("room", room)

    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "task context",
      { taskRequestId: "task-1" }
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: "task_target_not_in_room",
    })
    expect(test.room().attachments).toHaveLength(0)
  })

  it("keeps an ordinary Room attachment unscoped when no Task header is present", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "room copy"
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      attachment: { taskRequestId?: string }
    }
    expect(payload.attachment.taskRequestId).toBeUndefined()
    expect(test.room().attachments[0].taskRequestId).toBeUndefined()
  })

  it("still rejects an Agent that does not participate in the Task", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "agent-b", token: "tok-agent-b" },
      "not mine",
      { taskRequestId: "task-1" }
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: "task_attachment_not_participant",
    })
    expect(test.room().attachments).toHaveLength(0)
  })

  it("keeps the existing bounded Agent-readable size for Human Task attachments", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "x".repeat(768 * 1024 + 1),
      { taskRequestId: "task-1" }
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: "attachment_too_large",
    })
    expect(test.room().attachments).toHaveLength(0)
  })

  it("keeps the supported image/text attachment type bound for Human Task attachments", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "binary",
      { taskRequestId: "task-1", contentType: "application/zip" }
    )

    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({
      error: "unsupported_attachment_type",
    })
  })
})
