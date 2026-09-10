import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function makeRoom(): RoomRecord {
  return {
    createdAt: 1,
    expiresAt: FAR_FUTURE,
    participants: {
      human: {
        id: "human",
        name: "Human",
        kind: "human",
        connected: true,
        joinedAt: 1,
        lastSeenAt: 1,
        token: "human-token",
      },
      "agent-a": {
        id: "agent-a",
        name: "Agent A",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: 1,
        token: "agent-a-token",
      },
      "agent-b": {
        id: "agent-b",
        name: "Agent B",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: 1,
        token: "agent-b-token",
      },
    },
    messages: [
      {
        id: "request-message",
        peerId: "human",
        name: "Human",
        kind: "human",
        type: "action",
        actionType: "collab",
        sequence: 1,
        createdAt: 1,
        collab: {
          requestId: "task-1",
          kind: "request",
          fromParticipantId: "human",
          targetParticipantId: "agent-a",
          summary: "Build a local counter",
        },
        targets: ["agent-a"],
      },
      {
        id: "secondary-message",
        peerId: "agent-a",
        name: "Agent A",
        kind: "agent",
        type: "text",
        text: "Please also observe this task.",
        taskRequestId: "task-1",
        targets: ["agent-b"],
        sequence: 2,
        createdAt: 2,
      },
    ],
    nextMessageSequence: 2,
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    nextLiveTranscriptEpoch: 1,
    nextTranscriptSequence: 1,
    attachments: [],
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

function surface(revision = 1) {
  return {
    taskRequestId: "task-1",
    surfaceId: "counter",
    authorityAgentId: "client-supplied-but-overwritten",
    revision,
    root: {
      type: "Card",
      children: [
        { type: "Text", text: "Count" },
        { type: "Value", path: "count" },
        {
          type: "Button",
          label: "+1",
          action: { type: "increment", path: "count", amount: 1 },
        },
      ],
    },
    data: { count: 0 },
  }
}

function harness() {
  const store = new Map<string, unknown>([["room", makeRoom()]])
  const broadcasts: unknown[] = []
  const session = new RoomSession(
    {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async () => undefined,
        list: async () => new Map<string, unknown>(),
        setAlarm: async () => undefined,
        deleteAlarm: async () => undefined,
        getAlarm: async () => undefined,
      },
      getWebSockets: () => [],
      waitUntil: (promise: Promise<unknown>) => void promise,
      id: { toString: () => "task-live-view-room" },
    } as never,
    { SFU_ROOM: {} } as never
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
  return {
    session,
    store,
    broadcasts,
    control,
    room: () => store.get("room") as RoomRecord,
  }
}

describe("RoomSession Task Live View (#316)", () => {
  it("publishes the canonical primary Agent view and replaces it by revision", async () => {
    const test = harness()
    const first = await test.control({
      action: "agent-publish-live-view",
      participantId: "agent-a",
      token: "agent-a-token",
      taskRequestId: "task-1",
      surface: surface(),
    })
    expect(first.status).toBe(200)
    expect(test.room().taskLiveViews?.["task-1"]).toMatchObject({
      taskRequestId: "task-1",
      authorityAgentId: "agent-a",
      revision: 1,
    })
    expect(test.room().messages).toHaveLength(2)

    const replacement = await test.control({
      action: "agent-publish-live-view",
      participantId: "agent-a",
      token: "agent-a-token",
      taskRequestId: "task-1",
      surface: surface(2),
    })
    expect(replacement.status).toBe(200)
    expect(test.room().taskLiveViews?.["task-1"]?.revision).toBe(2)

    const stale = await test.control({
      action: "agent-publish-live-view",
      participantId: "agent-a",
      token: "agent-a-token",
      taskRequestId: "task-1",
      surface: surface(2),
    })
    expect(stale.status).toBe(409)
    expect((stale.json as { error: string }).error).toBe(
      "live_view_revision_conflict"
    )
    const browserState = (
      test.session as unknown as {
        stateFor: (room: RoomRecord) => { taskLiveViews?: unknown }
      }
    ).stateFor(test.room())
    expect(browserState.taskLiveViews?.["task-1"]).toMatchObject({
      revision: 2,
    })
  })

  it("rejects a secondary Agent and malformed or unsafe surfaces", async () => {
    const test = harness()
    const secondary = await test.control({
      action: "agent-publish-live-view",
      participantId: "agent-b",
      token: "agent-b-token",
      taskRequestId: "task-1",
      surface: surface(),
    })
    expect(secondary.status).toBe(403)
    expect((secondary.json as { error: string }).error).toBe(
      "live_view_not_authorized"
    )

    const unsafe = {
      ...surface(),
      root: { type: "Html", html: "<script>alert(1)</script>" },
    }
    const rejected = await test.control({
      action: "agent-publish-live-view",
      participantId: "agent-a",
      token: "agent-a-token",
      taskRequestId: "task-1",
      surface: unsafe,
    })
    expect(rejected.status).toBe(400)
    expect(test.room().taskLiveViews).toEqual({})
  })
})
