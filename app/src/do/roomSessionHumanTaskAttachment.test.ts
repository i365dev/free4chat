import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"
import { encodeTaskAttachmentWake } from "../common/taskAttachmentWake"
import type { RoomRecord } from "../room/types"

/**
 * #363 A2: a Human may attach into an ACTIVE Task through the existing
 * bounded Room attachment store. The canonical Task correlation is resolved
 * server-side and fails closed — unknown/expired Tasks or a Task with no
 * participating Agent in the Room are rejected before any bytes are stored,
 * and nothing is ever silently downgraded to ordinary Room scope.
 *
 * #363 second review: the composer's explicit wake intent rides the same
 * upload and is PERSISTED with the attachment, so the Agent event rebuilt from
 * Room state carries exactly the same `addressed` value as the live one.
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
        media: {
          sessionId: "human-session",
          muted: false,
          fileChannelReady: true,
          tracks: [],
        },
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
    options: {
      taskRequestId?: string
      contentType?: string
      /** The composer's wake intent. Left undefined to exercise an upload
       * that carries no explicit intent at all. */
      wakeAgent?: boolean
    } = {}
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
          ...(options.wakeAgent === undefined
            ? {}
            : {
                "X-Task-Attachment-Wake": encodeTaskAttachmentWake(
                  options.wakeAgent
                ),
              }),
        },
        body,
      })
    )
  // The browser's human Task text half: the ordinary authenticated Room
  // WebSocket chat message carrying the canonical task correlation.
  const humanSocket = {
    send: () => undefined,
    close: () => undefined,
  } as unknown as WebSocket
  const sendHumanTaskText = (text: string, taskRequestId = "task-1") =>
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
        participantId: "human-1",
        token: "tok-human",
        connectionNonce: "human-connection",
      },
      { type: "chat", text, taskRequestId }
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
  const agentWait = async (
    participantId: string,
    cursor = 0,
    timeoutSeconds = 0
  ) =>
    (
      await control({
        action: "agent-wait",
        participantId,
        token: `tok-${participantId}`,
        cursor,
        timeoutSeconds,
      })
    ).json as { events: AgentEventProjection[]; cursor: number }
  const readContext = async (participantId: string, afterSequence = 0) =>
    (
      await control({
        action: "agent-read-context",
        participantId,
        token: `tok-${participantId}`,
        afterSequence,
      })
    ).json as { events: AgentEventProjection[] }
  const room = () => store.get("room") as RoomRecord
  return {
    session,
    upload,
    control,
    agentWait,
    readContext,
    sendHumanTaskText,
    room,
    broadcasts,
    store,
  }
}

type AgentEventProjection = {
  sequence?: number
  type?: string
  addressed?: boolean
  scopeId?: string
  text?: string
  attachment?: { id: string; taskRequestId?: string }
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

/**
 * #363 review (point 3) / second review: a Human attachment correlated with an
 * ACTIVE Task is new Task input and can address the canonical participating
 * Task Agent(s) — but only when the composer explicitly said so. The wake
 * intent is persisted with the attachment, so the live event and the event
 * rebuilt from Room state agree.
 */
describe("Human Task attachment Agent addressing (#363 review point 3)", () => {
  async function uploadTaskAttachment(
    test: ReturnType<typeof makeRoom>,
    wakeAgent?: boolean
  ) {
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "task context",
      { taskRequestId: "task-1", wakeAgent }
    )
    const payload = (await response.json()) as { attachment: { id: string } }
    return { response, attachmentId: payload.attachment.id }
  }

  function attachmentEvent(
    events: AgentEventProjection[],
    attachmentId: string
  ) {
    return events.find((event) => event.attachment?.id === attachmentId)
  }

  it("addresses the canonical participating Task Agent for an attachment-only submission", async () => {
    const test = makeRoom()
    const { response, attachmentId } = await uploadTaskAttachment(test, true)
    expect(response.status).toBe(200)

    const { events } = await test.agentWait("agent-a", 0)
    expect(attachmentEvent(events, attachmentId)).toMatchObject({
      type: "image",
      addressed: true,
      scopeId: "task:task-1",
      attachment: { id: attachmentId, taskRequestId: "task-1" },
    })
  })

  it("wakes a parked Harness long poll with the addressed Task attachment", async () => {
    const test = makeRoom()
    // Park the long poll beyond the current canonical sequence so it really
    // waits, exactly like an idle resident Harness.
    const parked = test.agentWait(
      "agent-a",
      test.room().nextMessageSequence,
      25
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const { attachmentId } = await uploadTaskAttachment(test, true)

    const { events } = await parked
    expect(attachmentEvent(events, attachmentId)).toMatchObject({
      addressed: true,
      scopeId: "task:task-1",
    })
  })

  it("does not address a Task attachment that carries no explicit wake intent", async () => {
    const test = makeRoom()
    const { attachmentId } = await uploadTaskAttachment(test)

    // Absent intent fails closed: the record is stored with `taskWake: false`
    // and the event rebuilt from Room state stays unaddressed.
    expect(test.room().attachments[0].taskWake).toBe(false)
    const { events } = await test.readContext("agent-a")
    expect(attachmentEvent(events, attachmentId)).toMatchObject({
      addressed: false,
      scopeId: "task:task-1",
    })
  })

  it("never exposes or addresses the Task attachment to a non-participating Agent", async () => {
    const test = makeRoom()
    const { attachmentId } = await uploadTaskAttachment(test, true)

    const { events } = await test.agentWait("agent-b", 0)
    expect(attachmentEvent(events, attachmentId)).toBeUndefined()
  })

  it("keeps an ordinary Room-scope Human attachment unaddressed", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "room copy"
    )
    const payload = (await response.json()) as { attachment: { id: string } }

    // Room scope never even persists a wake intent.
    expect(test.room().attachments[0].taskWake).toBeUndefined()
    const { events } = await test.agentWait("agent-a", 0)
    const event = attachmentEvent(events, payload.attachment.id)
    expect(event).toMatchObject({ addressed: false })
    expect(event?.scopeId).toBeUndefined()
  })

  it("keeps an Agent-authored Task attachment unaddressed even with a wake intent", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "agent-a", token: "tok-agent-a" },
      "agent artifact",
      { taskRequestId: "task-1", wakeAgent: true }
    )
    const payload = (await response.json()) as { attachment: { id: string } }

    // An Agent can never choose the Human wake intent, and the persisted
    // record stays unaddressed on replay too.
    expect(test.room().attachments[0].taskWake).toBe(false)
    const { events } = await test.readContext("agent-a")
    expect(attachmentEvent(events, payload.attachment.id)).toMatchObject({
      addressed: false,
      scopeId: "task:task-1",
    })
  })

  it("produces no addressed event for a rejected Task correlation", async () => {
    const test = makeRoom()
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "task context",
      { taskRequestId: "task-missing", wakeAgent: true }
    )
    expect(response.status).toBe(409)

    const { events } = await test.agentWait("agent-a", 0)
    expect(events.some((event) => event.attachment !== undefined)).toBe(false)
  })
})

/**
 * #363 second review: one composer Send can carry an attachment and text
 * together. The Task attachment must be persisted first as Task context
 * WITHOUT independently waking the Task Agent, and the following addressed
 * Task text must be the single wake/turn boundary — with the attachment
 * visible in that first turn. An attachment-only Send still wakes.
 */
describe("Single Task wake boundary per composer submission (#363 second review)", () => {
  function attachmentEvent(
    events: AgentEventProjection[],
    attachmentId: string
  ) {
    return events.find((event) => event.attachment?.id === attachmentId)
  }

  function addressedEvents(events: AgentEventProjection[]) {
    return events.filter((event) => event.addressed === true)
  }

  async function uploadTaskAttachment(
    test: ReturnType<typeof makeRoom>,
    wakeAgent: boolean
  ) {
    const response = await test.upload(
      { id: "human-1", token: "tok-human" },
      "screenshot bytes",
      { taskRequestId: "task-1", wakeAgent }
    )
    const payload = (await response.json()) as { attachment: { id: string } }
    return payload.attachment.id
  }

  it("yields exactly one wake boundary for `attachment + text`, with the attachment inside it", async () => {
    const test = makeRoom()
    // Everything already retained (the original Task request) is outside this
    // composer submission.
    const submissionStart = test.room().nextMessageSequence
    // The composer decides: text is present, so the attachment is context.
    const text: string = "please inspect this"
    const attachmentId = await uploadTaskAttachment(test, text === "")
    await test.sendHumanTaskText(text)

    // Live delivery: exactly one addressed event, and it is the Task text.
    const { events } = await test.agentWait("agent-a", submissionStart)
    const addressed = addressedEvents(events)
    expect(addressed).toHaveLength(1)
    expect(addressed[0]).toMatchObject({
      type: "text",
      text,
      scopeId: "task:task-1",
    })
    // The attachment is Task context inside that same turn, not a wake.
    const attachment = attachmentEvent(events, attachmentId)
    expect(attachment).toMatchObject({
      addressed: false,
      scopeId: "task:task-1",
    })
    expect(attachment!.sequence!).toBeLessThan(addressed[0].sequence!)
    // ...and the Task Agent can still read its bytes in that turn.
    expect(
      await readAttachment(test.session, "agent-a", "tok-agent-a", attachmentId)
    ).toBe(200)

    // Replay/reconstruction from persisted Room state, not the live
    // broadcast, produces the identical boundary.
    const retained = (await test.readContext("agent-a", submissionStart)).events
    const replayed = addressedEvents(retained)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({ type: "text", text })
    const replayedAttachment = attachmentEvent(retained, attachmentId)
    expect(replayedAttachment).toMatchObject({ addressed: false })
    expect(replayedAttachment!.sequence!).toBeLessThan(replayed[0].sequence!)
  })

  it("does not resolve an idle Harness on the attachment half of `attachment + text`", async () => {
    const test = makeRoom()
    const parked = test.agentWait(
      "agent-a",
      test.room().nextMessageSequence,
      25
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const attachmentId = await uploadTaskAttachment(test, false)

    // The attachment alone produces no addressed event...
    const first = await parked
    expect(attachmentEvent(first.events, attachmentId)).toMatchObject({
      addressed: false,
    })
    expect(addressedEvents(first.events)).toHaveLength(0)

    // ...so the following Task text is the single wake boundary, and the
    // attachment is already persisted inside its context window.
    await test.sendHumanTaskText("please inspect this")
    const { events } = await test.agentWait("agent-a", first.cursor)
    const addressed = addressedEvents(events)
    expect(addressed).toHaveLength(1)
    expect(addressed[0]).toMatchObject({ type: "text", scopeId: "task:task-1" })
    // The retained Room state still shows the unaddressed attachment strictly
    // before the addressed Task text, inside the same Task scope.
    const retained = await test.readContext("agent-a")
    const attachment = attachmentEvent(retained.events, attachmentId)
    expect(attachment).toMatchObject({
      addressed: false,
      scopeId: "task:task-1",
    })
    expect(attachment!.sequence!).toBeLessThan(addressed[0].sequence!)
  })

  it("still wakes an idle Harness for an `attachment only` submission", async () => {
    const test = makeRoom()
    const parked = test.agentWait(
      "agent-a",
      test.room().nextMessageSequence,
      25
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const attachmentId = await uploadTaskAttachment(test, true)

    const { events } = await parked
    const addressed = addressedEvents(events)
    expect(addressed).toHaveLength(1)
    expect(addressed[0]).toMatchObject({
      type: "image",
      scopeId: "task:task-1",
      attachment: { id: attachmentId, taskRequestId: "task-1" },
    })

    // The persisted intent reproduces the same wake on replay.
    expect(test.room().attachments[0].taskWake).toBe(true)
    expect(
      attachmentEvent((await test.readContext("agent-a")).events, attachmentId)
    ).toMatchObject({ addressed: true })
  })
})
