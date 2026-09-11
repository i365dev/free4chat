import { describe, expect, it, vi, afterEach } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #228: Room-authoritative collaboration analytics end-to-end. Canonical,
// already-deduplicated Room transitions emit exactly one Mixpanel /import
// batch each; browser observation, DO restart, and replay never double
// count; absent secret and ingestion failure are harmless no-ops.

function buildStoredRoom() {
  return {
    createdAt: Date.now(),
    expiresAt: FAR_FUTURE,
    participants: {
      "agent-pi": {
        id: "agent-pi",
        name: "Pi",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-pi",
      },
      "agent-codex": {
        id: "agent-codex",
        name: "Codex",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-codex",
      },
    },
    messages: [],
    nextMessageSequence: 1,
    meetingNotes: { active: false },
    agentVoice: {},
    liveTranscript: { active: false },
    pendingMediaCleanup: [],
  }
}

function makeRoomSession(
  fetchCalls: Array<{ url: string; init: RequestInit }>,
  projectToken?: string,
  storedRoom: unknown = buildStoredRoom()
) {
  const store = new Map<string, unknown>([["room", storedRoom]])
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [] as WebSocket[],
    waitUntil: (promise: Promise<unknown>) => void promise,
    id: { name: "test-room", toString: () => "test-room" },
  }
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} })
    if (String(url).includes("api.mixpanel.com"))
      return Promise.resolve(new Response("{}", { status: 200 }))
    // Non-analytics endpoints (none expected in these tests) get a
    // generic success envelope.
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  })
  vi.stubGlobal("fetch", fetchImpl)

  const rs = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      AGENT_MEDIA_ENABLED: "true",
      ...(projectToken === undefined
        ? {}
        : { MIXPANEL_PROJECT_TOKEN: projectToken }),
    } as never
  )
  const control = async (body: Record<string, unknown>) => {
    const response = await rs.fetch(
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
  return { control, fetchCalls, fetchImpl }
}

function mixpanelBodies(
  calls: Array<{ url: string; init: RequestInit }>
): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.url.includes("api.mixpanel.com"))
    .map((c) => JSON.parse(c.init.body as string))
    .flat()
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("Room-authoritative collaboration analytics (#228)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("browserless Agent-only Room emits exactly one authoritative AgentJoined", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    const result = await control({
      action: "agent-register",
      participant: {
        id: "agent-hermes",
        name: "Hermes",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-hermes",
        capabilities: { text: true },
      },
    })
    expect(result.status).toBe(200)
    await flushMicrotasks()

    const rows = mixpanelBodies(calls).filter(
      (row) => row.event === "AgentJoined"
    )
    expect(rows.length).toBe(1)
    const properties = rows[0].properties as Record<string, unknown>
    expect(properties.roomComposition).toBe("agent-only")
    expect(properties.roomHash).toBeTruthy()
    expect(properties.roomHash).not.toContain("test-room")
  })

  it("duplicate registration never emits a second AgentJoined", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    const participant = {
      id: "agent-x",
      name: "X",
      kind: "agent",
      joinedAt: Date.now(),
      token: "tok-x",
      capabilities: { text: true },
    }
    await control({ action: "agent-register", participant })
    const rejected = await control({ action: "agent-register", participant })
    expect(rejected.status).toBe(409)
    await flushMicrotasks()

    expect(
      mixpanelBodies(calls).filter((row) => row.event === "AgentJoined").length
    ).toBe(1)
  })

  it("Agent→Agent request emits exactly one CollabRequested with correct topology", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    await control({
      action: "agent-register",
      participant: {
        id: "agent-a",
        name: "A",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-a",
        capabilities: { text: true },
      },
    })
    await control({
      action: "agent-register",
      participant: {
        id: "agent-b",
        name: "B",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-b",
        capabilities: { text: true },
      },
    })
    await flushMicrotasks()
    calls.length = 0

    const sent = await control({
      action: "agent-send-collab",
      participantId: "agent-a",
      token: "tok-a",
      event: {
        kind: "request",
        targetParticipantId: "agent-b",
        summary: "please review",
      },
    })
    expect(sent.status).toBe(200)
    await flushMicrotasks()

    const requested = mixpanelBodies(calls).filter(
      (row) => row.event === "CollabRequested"
    )
    expect(requested.length).toBe(1)
    const properties = requested[0].properties as Record<string, unknown>
    expect(properties.requesterKind).toBe("agent")
    expect(properties.targetKind).toBe("agent")
  })

  it("emits one coarse LiveViewPublished event for first and replacement publishes only", async () => {
    const baseRoom = buildStoredRoom()
    const taskRoom = {
      ...baseRoom,
      participants: {
        ...baseRoom.participants,
        human: {
          id: "human",
          name: "Human",
          kind: "human",
          connected: true,
          joinedAt: 1,
          lastSeenAt: 1,
          token: "human-token",
        },
      },
      messages: [
        {
          id: "task-request",
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
            targetParticipantId: "agent-pi",
            summary: "Build a counter",
          },
          targets: ["agent-pi"],
        },
      ],
      nextMessageSequence: 1,
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token", taskRoom)
    const publish = (revision: number) =>
      control({
        action: "agent-publish-live-view",
        participantId: "agent-pi",
        token: "tok-pi",
        taskRequestId: "task-1",
        surface: {
          surfaceId: "counter",
          revision,
          root: {
            type: "Value",
            path: "count",
          },
          data: { count: 0 },
        },
      })

    expect((await publish(1)).status).toBe(200)
    await flushMicrotasks()
    let rows = mixpanelBodies(calls).filter(
      (row) => row.event === "LiveViewPublished"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].properties).toMatchObject({ phase: "first" })
    expect(JSON.stringify(rows[0].properties)).not.toContain("task-1")
    expect(JSON.stringify(rows[0].properties)).not.toContain("agent-pi")

    calls.length = 0
    expect((await publish(2)).status).toBe(200)
    await flushMicrotasks()
    rows = mixpanelBodies(calls).filter(
      (row) => row.event === "LiveViewPublished"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].properties).toMatchObject({ phase: "replacement" })

    calls.length = 0
    expect((await publish(2)).status).toBe(409)
    await control({
      action: "agent-publish-live-view",
      participantId: "human",
      token: "human-token",
      taskRequestId: "task-1",
      surface: {
        surfaceId: "counter",
        revision: 3,
        root: { type: "Value", path: "count" },
        data: { count: 0 },
      },
    })
    expect(
      (
        await control({
          action: "agent-publish-live-view",
          participantId: "agent-pi",
          token: "tok-pi",
          taskRequestId: "task-1",
          surface: {
            surfaceId: "counter",
            revision: 3,
            root: { type: "Html", html: "<b>unsafe</b>" },
            data: { count: 0 },
          },
        })
      ).status
    ).toBe(400)
    await flushMicrotasks()
    expect(
      mixpanelBodies(calls).filter((row) => row.event === "LiveViewPublished")
    ).toHaveLength(0)
  })

  it("absent Mixpanel secret is a harmless no-op", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls) // no token
    const result = await control({
      action: "agent-register",
      participant: {
        id: "agent-a",
        name: "A",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-a",
        capabilities: { text: true },
      },
    })
    expect(result.status).toBe(200)
    await flushMicrotasks()
    expect(calls.filter((c) => c.url.includes("mixpanel")).length).toBe(0)
  })

  it("Mixpanel failure never fails the Room mutation", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control, fetchImpl } = makeRoomSession(calls, "project-token")
    fetchImpl.mockImplementation((url: string | URL | Request) => {
      calls.push({ url: String(url), init: {} })
      if (String(url).includes("api.mixpanel.com"))
        return Promise.reject(new Error("network down"))
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    })
    const result = await control({
      action: "agent-register",
      participant: {
        id: "agent-a",
        name: "A",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-a",
        capabilities: { text: true },
      },
    })
    expect(result.status).toBe(200)
    await flushMicrotasks()
  })
})
