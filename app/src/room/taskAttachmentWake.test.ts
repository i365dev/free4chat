import { describe, expect, it } from "vitest"

import { handleRoomRequest, type RoomProtocolEnv } from "./server"
import type { RoomRecord } from "./types"
import { encodeTaskAttachmentWake } from "../common/taskAttachmentWake"
import { RoomSession } from "../do/RoomSession"

/**
 * #363 second review, end-to-end-ish regression across the real composer
 * decision, the existing Worker attachment route, and the real RoomSession:
 *
 *   [ screenshot.png ] + "please inspect this"  => ONE wake/turn boundary
 *
 * The Task attachment is persisted first as Task context (its Agent event is
 * NOT addressed), and the following Task text is the single addressed wake —
 * so the first Harness turn sees both the attachment and the instruction.
 * An attachment-only submission still wakes the Task Agent on its own.
 *
 * The composer's decision (`wakeAgent = text === ""`) and the hook's encoder
 * are the only inputs this test supplies; the addressing decision itself is
 * made and persisted by the Room, and re-derived identically from Room state.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000
const TASK_ID = "task-1"
const ATTACHMENT_WAKE_HEADER = "X-Task-Attachment-Wake"

type AgentEventProjection = {
  sequence?: number
  type?: string
  addressed?: boolean
  scopeId?: string
  text?: string
  attachment?: { id: string; taskRequestId?: string }
}

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
          requestId: TASK_ID,
          kind: "request",
          fromParticipantId: "human-1",
          targetParticipantId: "agent-a",
          summary: "Review the attached screenshot",
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

function harness() {
  const store = new Map<string, unknown>([["room", buildStoredRoom()]])
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
    getWebSockets: () => [] as WebSocket[],
    waitUntil: (promise: Promise<unknown>) => void promise,
    id: { name: "test-room", toString: () => "test-room" },
  }
  const session = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      AGENT_MEDIA_ENABLED: "true",
    } as never
  )
  // The real Worker route forwards to this Room through the DO namespace
  // exactly as production does (idFromName(room) -> stub.fetch(request)).
  const env = {
    SFU_ROOM: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: (url: string | URL, init?: RequestInit) =>
          session.fetch(new Request(String(url), init)),
      }),
    },
  } as unknown as RoomProtocolEnv

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
    cursor: number,
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
  const sendHumanTaskText = (text: string) =>
    (
      session as unknown as {
        handleClientMessage: (
          socket: WebSocket,
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      { send: () => undefined, close: () => undefined } as unknown as WebSocket,
      {
        participantId: "human-1",
        token: "tok-human",
        connectionNonce: "human-connection",
      },
      { type: "chat", text, taskRequestId: TASK_ID }
    )
  const readAttachment = async (participantId: string, attachmentId: string) =>
    (
      await control({
        action: "agent-read-attachment",
        participantId,
        token: `tok-${participantId}`,
        attachmentId,
      })
    ).status
  const storedRoom = () => store.get("room") as RoomRecord

  /** One composer Send: the attachment half first (exactly as the composer
   * awaits its readiness edge), then the text half when there is text. */
  async function composerSubmit(text: string) {
    const bytes = "screenshot bytes"
    // The composer's own decision, mirrored verbatim.
    const wakeAgent = text === ""
    const response = await handleRoomRequest(
      new Request("https://www.free4.chat/api/room/attachments", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "image/png",
          "Content-Length": String(bytes.length),
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "human-1",
          "X-Room-Participant-Token": "tok-human",
          "X-File-Name": encodeURIComponent("screenshot.png"),
          "X-Task-Request-Id": TASK_ID,
          // The hook's own bounded encoding of that decision.
          [ATTACHMENT_WAKE_HEADER]: encodeTaskAttachmentWake(wakeAgent),
        },
        body: bytes,
      }),
      env
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { attachment: { id: string } }
    if (text !== "") await sendHumanTaskText(text)
    return payload.attachment.id
  }

  const submissionStart = () => storedRoom().nextMessageSequence
  const attachmentEvent = (
    events: AgentEventProjection[],
    attachmentId: string
  ) => events.find((event) => event.attachment?.id === attachmentId)
  const addressedEvents = (events: AgentEventProjection[]) =>
    events.filter((event) => event.addressed === true)

  return {
    env,
    session,
    composerSubmit,
    submissionStart,
    agentWait,
    readContext,
    readAttachment,
    attachmentEvent,
    addressedEvents,
    storedRoom,
  }
}

describe("Task composer submission wake boundary (#363 second review)", () => {
  it("`attachment + text` produces exactly one wake boundary with the attachment inside it", async () => {
    const test = harness()
    const start = test.submissionStart()
    const instruction = "please inspect this"

    const attachmentId = await test.composerSubmit(instruction)

    // Live delivery through the real Worker route + DO: the only addressed
    // event of this submission is the Task text.
    const { events } = await test.agentWait("agent-a", start)
    const addressed = test.addressedEvents(events)
    expect(addressed).toHaveLength(1)
    expect(addressed[0]).toMatchObject({
      type: "text",
      text: instruction,
      scopeId: `task:${TASK_ID}`,
    })

    // The attachment is visible in that same turn as unaddressed Task
    // context, and its bytes are readable by the Task Agent.
    const attachment = test.attachmentEvent(events, attachmentId)
    expect(attachment).toMatchObject({
      type: "image",
      addressed: false,
      scopeId: `task:${TASK_ID}`,
    })
    expect(attachment!.sequence!).toBeLessThan(addressed[0].sequence!)
    expect(await test.readAttachment("agent-a", attachmentId)).toBe(200)

    // Rebuilding the Agent events from persisted Room state (not the live
    // broadcast) reproduces the identical single boundary.
    const retained = (await test.readContext("agent-a", start)).events
    const replayed = test.addressedEvents(retained)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({ type: "text", text: instruction })
    const replayedAttachment = test.attachmentEvent(retained, attachmentId)
    expect(replayedAttachment).toMatchObject({
      addressed: false,
      scopeId: `task:${TASK_ID}`,
    })
    expect(replayedAttachment!.sequence!).toBeLessThan(replayed[0].sequence!)
  })

  it("does not resolve an idle Harness on the attachment half of `attachment + text`", async () => {
    const test = harness()
    const parked = test.agentWait("agent-a", test.submissionStart(), 25)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const attachmentId = await test.composerSubmit("please inspect this")

    // The attachment half carries no wake at all.
    const first = await parked
    expect(test.attachmentEvent(first.events, attachmentId)).toMatchObject({
      addressed: false,
    })
    expect(test.addressedEvents(first.events)).toHaveLength(0)

    // The Task text is the single addressed boundary, and the attachment is
    // already persisted inside its context window.
    const { events } = await test.agentWait("agent-a", first.cursor)
    expect(test.addressedEvents(events)).toHaveLength(1)
    const retained = (await test.readContext("agent-a")).events
    expect(test.attachmentEvent(retained, attachmentId)).toMatchObject({
      addressed: false,
    })
  })

  it("`attachment only` still wakes the Task Agent", async () => {
    const test = harness()
    const parked = test.agentWait("agent-a", test.submissionStart(), 25)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const attachmentId = await test.composerSubmit("")

    const { events } = await parked
    const addressed = test.addressedEvents(events)
    expect(addressed).toHaveLength(1)
    expect(addressed[0]).toMatchObject({
      type: "image",
      scopeId: `task:${TASK_ID}`,
      attachment: { id: attachmentId, taskRequestId: TASK_ID },
    })
    // Replay carries the same persisted wake intent.
    expect(test.storedRoom().attachments[0].taskWake).toBe(true)
    expect(
      test.attachmentEvent(
        (await test.readContext("agent-a")).events,
        attachmentId
      )
    ).toMatchObject({ addressed: true })
  })

  it("still fails closed for a Task the Room can no longer resolve", async () => {
    const test = harness()
    // The Task correlation is gone: the attachment half must never be
    // silently downgraded to Room scope, and no Task event may appear.
    const room = test.storedRoom()
    room.messages = []
    const bytes = "screenshot bytes"
    const response = await handleRoomRequest(
      new Request("https://www.free4.chat/api/room/attachments", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "image/png",
          "Content-Length": String(bytes.length),
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "human-1",
          "X-Room-Participant-Token": "tok-human",
          "X-File-Name": encodeURIComponent("screenshot.png"),
          "X-Task-Request-Id": TASK_ID,
          [ATTACHMENT_WAKE_HEADER]: encodeTaskAttachmentWake(true),
        },
        body: bytes,
      }),
      test.env
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: "unknown_task_request",
    })
    expect(test.storedRoom().attachments).toHaveLength(0)
    const { events } = await test.agentWait("agent-a", 0)
    expect(events.some((event) => event.attachment !== undefined)).toBe(false)
  })
})
