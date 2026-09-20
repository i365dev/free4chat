import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import {
  TASK_ATTACHMENT_PENDING_HEADER,
  TASK_ATTACHMENT_WAKE_HEADER,
} from "../common/taskAttachmentWake"
import type { RoomRecord } from "../room/types"

/**
 * #421 — a large Start Task brief must be INSIDE the canonical Task.
 *
 * Production dogfood had to work around this by creating an empty Task and
 * pasting the real brief as a follow-up attachment. The product must not
 * require that trick, and the Agent's FIRST meaningful turn must already see
 * the real brief.
 *
 * The mechanism under test: the Start Task modal pins the canonical Task
 * requestId, stages the exact brief as a Task-correlated attachment against
 * that id (an explicitly marked PRE-TASK upload, since the Task does not exist
 * yet), and only then creates the Task with the same id and an explicit
 * `attachmentIds` reference. One canonical Task, one addressed wake, one
 * attachment, and nothing downgraded to Room scope.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

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
  }
}

function room(): RoomRecord {
  return {
    createdAt: 1,
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
    getWebSockets: () => [humanSocket] as unknown as WebSocket[],
  }

  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)

  const frames = () =>
    (humanSocket.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      JSON.parse(call[0] as string)
    )

  return {
    session,
    store,
    stored: () => store.get("room") as RoomRecord,
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
    errors: () =>
      frames()
        .filter((frame) => frame.type === "error")
        .map((frame) => frame.error),
    messages: () =>
      frames()
        .filter((frame) => frame.type === "message")
        .map((frame) => frame.message),
    upload: (
      participantId: string,
      body: string,
      headers: Record<string, string>
    ) =>
      session.fetch(
        new Request("https://room/attachment", {
          method: "POST",
          headers: {
            "Content-Type": "text/markdown",
            "X-Room-Participant-Id": participantId,
            "X-Room-Participant-Token": `${participantId}-token`,
            "X-File-Name": encodeURIComponent("task-brief.md"),
            ...headers,
          },
          body,
        })
      ),
  }
}

const BRIEF = `# Production handoff\n\n${"line of the real brief\n".repeat(
  300
)}`

async function stageBrief(
  test: ReturnType<typeof harness>,
  requestId: string,
  participantId = "human-1",
  brief = BRIEF
): Promise<string> {
  const response = await test.upload(participantId, brief, {
    "X-Task-Request-Id": requestId,
    [TASK_ATTACHMENT_PENDING_HEADER]: "1",
  })
  expect(response.status).toBe(200)
  const payload = (await response.json()) as {
    attachment: { id: string; taskRequestId?: string }
  }
  return payload.attachment.id
}

describe("Start Task large brief (#421)", () => {
  it("stages a pre-Task brief against the pinned canonical Task id", async () => {
    const test = harness()
    const requestId = crypto.randomUUID()
    const attachmentId = await stageBrief(test, requestId)

    const attachment = test.stored().attachments[0]
    expect(attachment).toMatchObject({
      id: attachmentId,
      taskRequestId: requestId,
      senderId: "human-1",
      senderKind: "human",
      mimeType: "text/markdown",
      size: new TextEncoder().encode(BRIEF).byteLength,
    })
    // PRE-TASK context is never a wake: the canonical Task event that follows
    // is the single addressed wake boundary.
    expect(attachment.taskWake).toBe(false)
  })

  it("creates ONE canonical Task whose event references the exact brief", async () => {
    const test = harness()
    const requestId = crypto.randomUUID()
    const attachmentId = await stageBrief(test, requestId)
    const sequenceBefore = test.stored().nextMessageSequence

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Ship the handoff",
      requestId,
      attachmentIds: [attachmentId],
    })

    expect(test.errors()).toEqual([])
    const created = test.stored().messages
    // Exactly one canonical Task event, and the pre-staged brief is now its
    // context rather than a second, unrelated Room artifact.
    expect(created).toHaveLength(1)
    expect(created[0].collab).toMatchObject({
      requestId,
      kind: "request",
      fromParticipantId: "human-1",
      targetParticipantId: "agent-a",
      summary: "Ship the handoff",
      attachmentIds: [attachmentId],
    })
    expect(created[0].targets).toEqual(["agent-a"])
    expect(test.stored().nextMessageSequence).toBe(sequenceBefore + 1)
    // Exactly one addressed wake: the brief itself never produced one.
    expect(
      test.messages().filter((message) => message.type === "action")
    ).toHaveLength(1)
    expect(test.stored().attachments[0].taskRequestId).toBe(requestId)
  })

  it("keeps the brief out of Room scope and out of any other Task", async () => {
    const test = harness()
    const first = crypto.randomUUID()
    const attachmentId = await stageBrief(test, first)
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "First task",
      requestId: first,
      attachmentIds: [attachmentId],
    })

    // A second, ordinary Task in the same Room never inherits the brief.
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-b",
      summary: "Second task",
    })
    const second = test.stored().messages[1].collab?.requestId
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    expect(test.stored().messages[1].collab?.attachmentIds).toBeUndefined()

    // And the brief is never downgraded to an ordinary Room-scope attachment.
    expect(test.stored().attachments.map((a) => a.taskRequestId)).toEqual([
      first,
    ])
  })

  it("still refuses an unknown Task without the explicit pre-Task marker", async () => {
    const test = harness()
    const response = await test.upload("human-1", BRIEF, {
      "X-Task-Request-Id": crypto.randomUUID(),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "unknown_task_request" })
    expect(test.stored().attachments).toEqual([])
  })

  it("refuses the pre-Task marker for an Agent or a malformed id", async () => {
    const test = harness()
    const asAgent = await test.upload("agent-a", BRIEF, {
      "X-Task-Request-Id": crypto.randomUUID(),
      [TASK_ATTACHMENT_PENDING_HEADER]: "1",
    })
    expect(asAgent.status).toBe(400)

    // An unhonorable marker is refused outright — it is never silently
    // downgraded to an ordinary Room-scope attachment.
    for (const bad of ["", "  ", "x".repeat(65)]) {
      const malformed = await test.upload("human-1", BRIEF, {
        "X-Task-Request-Id": bad,
        [TASK_ATTACHMENT_PENDING_HEADER]: "1",
      })
      expect(malformed.status).toBe(400)
    }
    expect(test.stored().attachments).toEqual([])
  })

  it("ignores a wake intent on a pre-Task brief", async () => {
    const test = harness()
    const requestId = crypto.randomUUID()
    const response = await test.upload("human-1", BRIEF, {
      "X-Task-Request-Id": requestId,
      [TASK_ATTACHMENT_PENDING_HEADER]: "1",
      [TASK_ATTACHMENT_WAKE_HEADER]: "1",
    })
    expect(response.status).toBe(200)
    expect(test.stored().attachments[0].taskWake).toBe(false)
  })

  it("fails closed when the pinned id already names a Task", async () => {
    const test = harness()
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Existing task",
    })
    const existing = test.stored().messages[0].collab?.requestId as string
    const attachmentId = await stageBrief(test, existing)

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Hijack attempt",
      requestId: existing,
      attachmentIds: [attachmentId],
    })

    // The pre-staged brief can never be attached to a Task this action did not
    // create, and no second message is appended.
    expect(test.errors()).toEqual(["task_request_id_in_use"])
    expect(test.stored().messages).toHaveLength(1)
  })

  it("refuses a reference to another Human's attachment", async () => {
    const test = harness()
    const requestId = crypto.randomUUID()
    const attachmentId = await stageBrief(test, requestId, "human-2")

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Not mine",
      requestId,
      attachmentIds: [attachmentId],
    })

    expect(test.errors()).toEqual(["unknown_attachment"])
    expect(test.stored().messages).toEqual([])
  })

  it("refuses a brief correlated with a DIFFERENT Task", async () => {
    const test = harness()
    const staged = crypto.randomUUID()
    const attachmentId = await stageBrief(test, staged)

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Wrong correlation",
      requestId: crypto.randomUUID(),
      attachmentIds: [attachmentId],
    })

    expect(test.errors()).toEqual(["attachment_task_mismatch"])
    expect(test.stored().messages).toEqual([])
  })

  it("keeps ordinary Start Task requests byte-for-byte unchanged", async () => {
    const test = harness()
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Ordinary task",
    })
    const created = test.stored().messages[0]
    expect(test.errors()).toEqual([])
    expect(created.collab).toMatchObject({
      kind: "request",
      summary: "Ordinary task",
    })
    expect(created.collab?.attachmentIds).toBeUndefined()
    // The Room still generates the canonical id itself.
    expect(typeof created.collab?.requestId).toBe("string")
    expect(created.collab?.requestId.length).toBeGreaterThan(0)
  })
})
