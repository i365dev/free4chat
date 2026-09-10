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

function surface(revision = 1, taskRequestId = "task-1") {
  return {
    taskRequestId,
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

function nearLimitSurface(taskRequestId: string, revision = 1) {
  const data = Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      `payload${index}`,
      "界".repeat(400),
    ])
  )
  return { ...surface(revision, taskRequestId), data: { count: 0, ...data } }
}

function appendTask(room: RoomRecord, taskRequestId: string) {
  const sequence = room.nextMessageSequence + 1
  room.messages.push({
    id: `request-${taskRequestId}`,
    peerId: "human",
    name: "Human",
    kind: "human",
    type: "action",
    actionType: "collab",
    sequence,
    createdAt: sequence,
    collab: {
      requestId: taskRequestId,
      kind: "request",
      fromParticipantId: "human",
      targetParticipantId: "agent-a",
      summary: "Build another local counter",
    },
    targets: ["agent-a"],
  })
  room.nextMessageSequence = sequence
}

function makeSession(store: Map<string, unknown>) {
  return new RoomSession(
    {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (key: string | string[]) => {
          for (const candidate of Array.isArray(key) ? key : [key])
            store.delete(candidate)
        },
        list: async (options?: { prefix?: string; limit?: number }) => {
          const entries = [...store.entries()].filter(([key]) =>
            options?.prefix ? key.startsWith(options.prefix) : true
          )
          return new Map(entries.slice(0, options?.limit ?? entries.length))
        },
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
}

async function control(session: RoomSession, body: Record<string, unknown>) {
  const response = await session.fetch(
    new Request("https://room/control", {
      method: "POST",
      body: JSON.stringify(body),
    })
  )
  return { status: response.status, json: await response.json() }
}

function harness() {
  const store = new Map<string, unknown>([["room", makeRoom()]])
  const broadcasts: unknown[] = []
  const session = makeSession(store)
  return {
    session,
    store,
    broadcasts,
    control: (body: Record<string, unknown>) => control(session, body),
    controlWith: (other: RoomSession, body: Record<string, unknown>) =>
      control(other, body),
    newSession: () => makeSession(store),
    load: () =>
      (
        session as unknown as { loadRoom: () => Promise<RoomRecord | null> }
      ).loadRoom(),
    loadWith: (other: RoomSession) =>
      (
        other as unknown as { loadRoom: () => Promise<RoomRecord | null> }
      ).loadRoom(),
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
    expect(test.room()).not.toHaveProperty("taskLiveViews")
    expect(test.store.get("task-live-view:task-1")).toMatchObject({
      taskRequestId: "task-1",
      authorityAgentId: "agent-a",
      revision: 1,
    })
    expect(test.room().messages).toHaveLength(2)
    const firstLoaded = await test.load()
    expect(firstLoaded?.taskLiveViews?.["task-1"]).toMatchObject({
      revision: 1,
    })

    const replacement = await test.control({
      action: "agent-publish-live-view",
      participantId: "agent-a",
      token: "agent-a-token",
      taskRequestId: "task-1",
      surface: surface(2),
    })
    expect(replacement.status).toBe(200)
    expect(
      (test.store.get("task-live-view:task-1") as { revision: number }).revision
    ).toBe(2)
    expect((await test.load())?.taskLiveViews?.["task-1"]?.revision).toBe(2)

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
    ).stateFor((await test.load()) as RoomRecord)
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
    expect(test.room()).not.toHaveProperty("taskLiveViews")
    expect(test.store.has("task-live-view:task-1")).toBe(false)
  })

  it("keeps Live View authority with the initial Agent after it leaves", async () => {
    const test = harness()
    expect(
      (
        await test.control({
          action: "agent-publish-live-view",
          participantId: "agent-a",
          token: "agent-a-token",
          taskRequestId: "task-1",
          surface: surface(),
        })
      ).status
    ).toBe(200)

    delete test.room().participants["agent-a"]
    const reloaded = test.newSession()
    const secondary = await test.controlWith(reloaded, {
      action: "agent-publish-live-view",
      participantId: "agent-b",
      token: "agent-b-token",
      taskRequestId: "task-1",
      surface: surface(2),
    })
    expect(secondary.status).toBe(403)
    expect((secondary.json as { error: string }).error).toBe(
      "live_view_not_authorized"
    )
    const loaded = await test.loadWith(reloaded)
    expect(loaded?.taskLiveViews?.["task-1"]).toMatchObject({
      authorityAgentId: "agent-a",
      revision: 1,
    })
    const browserState = (
      reloaded as unknown as {
        stateFor: (room: RoomRecord) => { taskLiveViews?: unknown }
      }
    ).stateFor(loaded as RoomRecord)
    expect(browserState.taskLiveViews?.["task-1"]).toMatchObject({
      authorityAgentId: "agent-a",
      revision: 1,
    })
  })

  it("keeps near-limit current views out of the primary Room value", async () => {
    const test = harness()
    const taskIds = ["task-1", "task-2", "task-3", "task-4"]
    for (const taskRequestId of taskIds.slice(1))
      appendTask(test.room(), taskRequestId)

    for (const taskRequestId of taskIds) {
      const candidate = nearLimitSurface(taskRequestId)
      const size = new TextEncoder().encode(
        JSON.stringify(candidate)
      ).byteLength
      expect(size).toBeGreaterThan(30 * 1024)
      expect(size).toBeLessThanOrEqual(32 * 1024)
      expect(
        (
          await test.control({
            action: "agent-publish-live-view",
            participantId: "agent-a",
            token: "agent-a-token",
            taskRequestId,
            surface: candidate,
          })
        ).status
      ).toBe(200)
    }

    const primary = test.room() as unknown as Record<string, unknown>
    expect(primary).not.toHaveProperty("taskLiveViews")
    expect(
      new TextEncoder().encode(JSON.stringify(primary)).byteLength
    ).toBeLessThan(128 * 1024)
    for (const taskRequestId of taskIds)
      expect(test.store.has(`task-live-view:${taskRequestId}`)).toBe(true)

    const reloaded = test.newSession()
    const loaded = await test.loadWith(reloaded)
    expect(Object.keys(loaded?.taskLiveViews ?? {})).toEqual(taskIds)
    expect(loaded?.taskLiveViews?.["task-4"]?.revision).toBe(1)
  })

  it("cleans a dedicated view when its canonical Task root is gone", async () => {
    const test = harness()
    expect(
      (
        await test.control({
          action: "agent-publish-live-view",
          participantId: "agent-a",
          token: "agent-a-token",
          taskRequestId: "task-1",
          surface: surface(),
        })
      ).status
    ).toBe(200)
    test.room().messages = test
      .room()
      .messages.filter((message) => message.collab?.requestId !== "task-1")

    const reloaded = test.newSession()
    const loaded = await test.loadWith(reloaded)
    expect(loaded?.taskLiveViews).toEqual({})
    expect(test.store.has("task-live-view:task-1")).toBe(false)
  })

  it("preserves the sixteen-view bound with dedicated keys", async () => {
    const test = harness()
    for (let index = 2; index <= 18; index += 1) {
      const taskRequestId = `task-${index}`
      appendTask(test.room(), taskRequestId)
      const result = await test.control({
        action: "agent-publish-live-view",
        participantId: "agent-a",
        token: "agent-a-token",
        taskRequestId,
        surface: surface(1, taskRequestId),
      })
      if (index <= 17) expect(result.status).toBe(200)
      else {
        expect(result.status).toBe(409)
        expect((result.json as { error: string }).error).toBe(
          "live_view_capacity"
        )
      }
    }
    expect(
      [...test.store.keys()].filter((key) => key.startsWith("task-live-view:"))
    ).toHaveLength(16)
  })
})
