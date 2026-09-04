import { describe, expect, it, vi, afterEach } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #234: exactly ONE RoomCreated per canonical Room generation. The
// registration that materializes a previously-nonexistent Room (Browser or
// MCP join/create) and the MCP create_room path both emit it; joining an
// existing Room and failed/collision attempts emit none. creationSource and
// creatorKind are coarse internal telemetry — never authorization.

function makeRoomSession(
  fetchCalls: Array<{ url: string; init: RequestInit }>,
  projectToken: string,
  options: { preexistingRoom?: boolean } = {}
) {
  const store = new Map<string, unknown>(
    options.preexistingRoom === false
      ? []
      : [
          [
            "room",
            {
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
                  token: "tok-agent-pi",
                  capabilities: { text: true },
                },
              },
              messages: [],
              nextMessageSequence: 1,
              meetingNotes: { active: false },
              agentVoice: {},
              liveTranscript: { active: false },
              pendingMediaCleanup: [],
            },
          ],
        ]
  )
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
      MIXPANEL_PROJECT_TOKEN: projectToken,
    } as never
  )
  const control = async (body: Record<string, unknown>) => {
    const response = await rs.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
    return response.status
  }
  return { control, fetchCalls }
}

function mixpanelRows(calls: Array<{ url: string; init: RequestInit }>) {
  return calls
    .filter((c) => c.url.includes("api.mixpanel.com"))
    .map((c) => JSON.parse(c.init.body as string))
    .flat() as Array<{ event: string; properties: Record<string, unknown> }>
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("RoomCreated Room-authoritative analytics (#234)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("Browser first registration on a missing room emits exactly one RoomCreated (human/browser)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token", {
      preexistingRoom: false,
    })
    const status = await control({
      action: "register",
      creationSource: "browser",
      participant: {
        id: "human-h",
        name: "Hannah",
        kind: "human",
        joinedAt: Date.now(),
        token: "tok-human",
        media: {
          sessionId: "s",
          muted: false,
          fileChannelReady: false,
          tracks: [],
        },
      },
    })
    expect(status).toBe(200)
    await flushMicrotasks()

    const created = mixpanelRows(calls).filter((r) => r.event === "RoomCreated")
    expect(created).toHaveLength(1)
    expect(created[0].properties.creatorKind).toBe("human")
    expect(created[0].properties.creationSource).toBe("browser")
    expect(created[0].properties.roomHash).toBeTruthy()
    expect(created[0].properties.roomHash).not.toContain("test-room")
    expect(created[0].properties.distinct_id).toBe("server:free4chat")
    // Privacy: no participant ids/names or raw room name.
    const serialized = JSON.stringify(created[0])
    expect(serialized.includes("human-h")).toBe(false)
    expect(serialized.includes("Hannah")).toBe(false)
    expect(serialized.includes("test-room")).toBe(false)
  })

  it("official Runtime create_room emits exactly one RoomCreated (agent/agent-runtime)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token", {
      preexistingRoom: false,
    })
    const status = await control({
      action: "agent-create-room",
      creationSource: "agent-runtime",
      participant: {
        id: "agent-hermes",
        name: "Hermes",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-hermes",
        capabilities: { text: true },
      },
    })
    expect(status).toBe(200)
    await flushMicrotasks()

    const created = mixpanelRows(calls).filter((r) => r.event === "RoomCreated")
    expect(created).toHaveLength(1)
    expect(created[0].properties.creatorKind).toBe("agent")
    expect(created[0].properties.creationSource).toBe("agent-runtime")
    // The same generation also emits exactly one AgentJoined as before.
    expect(
      mixpanelRows(calls).filter((r) => r.event === "AgentJoined")
    ).toHaveLength(1)
  })

  it("other MCP create_room emits exactly one RoomCreated (agent/mcp)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token", {
      preexistingRoom: false,
    })
    const status = await control({
      action: "agent-create-room",
      creationSource: "mcp",
      participant: {
        id: "agent-x",
        name: "X",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-x",
      },
    })
    expect(status).toBe(200)
    await flushMicrotasks()
    const created = mixpanelRows(calls).filter((r) => r.event === "RoomCreated")
    expect(created).toHaveLength(1)
    expect(created[0].properties.creationSource).toBe("mcp")
    expect(created[0].properties.creatorKind).toBe("agent")
  })

  it("agent-register on a MISSING room materializes a generation and emits one RoomCreated", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token", {
      preexistingRoom: false,
    })
    const status = await control({
      action: "agent-register",
      creationSource: "mcp",
      participant: {
        id: "agent-1",
        name: "One",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-1",
      },
    })
    expect(status).toBe(200)
    await flushMicrotasks()
    const created = mixpanelRows(calls).filter((r) => r.event === "RoomCreated")
    expect(created).toHaveLength(1)
    expect(created[0].properties.creatorKind).toBe("agent")
    expect(created[0].properties.creationSource).toBe("mcp")
  })

  it("MCP agent-register joining an EXISTING room emits no RoomCreated", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token") // room exists
    const status = await control({
      action: "agent-register",
      creationSource: "agent-runtime",
      participant: {
        id: "agent-2",
        name: "Second",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-2",
      },
    })
    expect(status).toBe(200)
    await flushMicrotasks()
    expect(
      mixpanelRows(calls).filter((r) => r.event === "RoomCreated")
    ).toHaveLength(0)
  })

  it("failed create / collision attempts emit no RoomCreated", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token", {
      preexistingRoom: false,
    })
    const participant = {
      id: "agent-1",
      name: "One",
      kind: "agent",
      joinedAt: Date.now(),
      token: "tok-1",
    }
    // An invalid creator kind on a missing room is rejected BEFORE any
    // generation exists — nothing is emitted.
    expect(
      await control({
        action: "agent-create-room",
        creationSource: "mcp",
        participant: { ...participant, id: "agent-0", kind: "human" },
      })
    ).toBe(400)
    await flushMicrotasks()
    expect(
      mixpanelRows(calls).filter((r) => r.event === "RoomCreated")
    ).toHaveLength(0)
    calls.length = 0
    // First create succeeds (one RoomCreated)...
    expect(
      await control({
        action: "agent-create-room",
        creationSource: "mcp",
        participant,
      })
    ).toBe(200)
    await flushMicrotasks()
    calls.length = 0
    // ...a colliding create with the same room id is rejected and emits
    // nothing.
    expect(
      await control({
        action: "agent-create-room",
        creationSource: "mcp",
        participant,
      })
    ).toBe(409)
    await flushMicrotasks()
    expect(
      mixpanelRows(calls).filter((r) => r.event === "RoomCreated")
    ).toHaveLength(0)
  })

  it("creationSource is telemetry only — it never affects Room behavior", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token", {
      preexistingRoom: false,
    })
    const status = await control({
      action: "agent-create-room",
      creationSource: "mcp",
      participant: {
        id: "agent-1",
        name: "One",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-1",
      },
    })
    expect(status).toBe(200)
    await flushMicrotasks()
    // The room was created regardless of the telemetry value.
    expect(
      mixpanelRows(calls).filter((r) => r.event === "RoomCreated")
    ).toHaveLength(1)
  })
})
