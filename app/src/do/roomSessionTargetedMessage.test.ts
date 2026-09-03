import { describe, expect, it, vi, afterEach } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #234: one server-authoritative TargetedMessage per canonical accepted TEXT
// message with explicit Room targets. Emission happens at the Room/DO
// mutation boundary (never a browser observer), exactly once per message,
// and never for unaddressed text or structured collab action envelopes.
// Absent Mixpanel token and ingestion failures stay harmless no-ops.

function buildStoredRoom() {
  return {
    createdAt: Date.now(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": {
        id: "human-1",
        name: "Human",
        kind: "human",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-human",
        media: {},
      },
      "agent-pi": {
        id: "agent-pi",
        name: "Pi",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-agent-pi",
      },
      "agent-codex": {
        id: "agent-codex",
        name: "Codex",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-agent-codex",
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
  projectToken?: string
) {
  const store = new Map<string, unknown>([["room", buildStoredRoom()]])
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
  const sendHuman = (message: object) =>
    (
      rs as unknown as {
        handleClientMessage: (
          socket: unknown,
          attachment: unknown,
          message: unknown
        ) => void
      }
    ).handleClientMessage(
      { send: () => undefined, close: () => undefined },
      { participantId: "human-1", token: "tok-human", connectionNonce: "n" },
      message
    )
  const agentWait = async (participantId: string, cursor = 0) =>
    control({
      action: "agent-wait",
      participantId,
      token: `tok-${participantId}`,
      cursor,
      timeoutSeconds: 0,
    })
  return { control, sendHuman, agentWait, fetchCalls }
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

describe("TargetedMessage Room-authoritative analytics (#234)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("Human→Agent targeted text emits exactly one TargetedMessage with senderKind human", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { sendHuman, control } = makeRoomSession(calls, "project-token")
    await control({
      action: "agent-register",
      participant: {
        id: "agent-extra",
        name: "Extra",
        kind: "agent",
        joinedAt: Date.now(),
        token: "tok-extra",
        capabilities: { text: true },
      },
    })
    calls.length = 0

    await sendHuman({
      type: "chat",
      text: "@Pi validate this",
      targets: ["agent-pi"],
    })
    await flushMicrotasks()

    const rows = mixpanelBodies(calls).filter(
      (row) => row.event === "TargetedMessage"
    )
    expect(rows.length).toBe(1)
    const properties = rows[0].properties as Record<string, unknown>
    expect(properties.senderKind).toBe("human")
    expect(properties.targetKind).toBe("agent")
    expect(properties.targetCountBucket).toBe("1")
    expect(properties.roomComposition).toBe("mixed")
    expect(properties.roomHash).toBeTruthy()
    expect(properties.roomHash).not.toContain("test-room")
    expect((rows[0].properties as Record<string, unknown>).distinct_id).toBe(
      "server:free4chat"
    )
    expect(JSON.stringify(rows[0]).includes("agent-pi")).toBe(false)
    expect(JSON.stringify(rows[0]).includes("validate this")).toBe(false)
  })

  it("Agent→Agent targeted text emits exactly one TargetedMessage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    const sent = await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "please review fib.py",
      targetParticipantIds: ["agent-codex"],
    })
    expect(sent.status).toBe(200)
    await flushMicrotasks()

    const rows = mixpanelBodies(calls).filter(
      (row) => row.event === "TargetedMessage"
    )
    expect(rows.length).toBe(1)
    expect((rows[0].properties as Record<string, unknown>).senderKind).toBe(
      "agent"
    )
    expect((rows[0].properties as Record<string, unknown>).targetKind).toBe(
      "agent"
    )
  })

  it("multi-target text emits ONE TargetedMessage, not one per target", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control, sendHuman } = makeRoomSession(calls, "project-token")
    await sendHuman({
      type: "chat",
      text: "@Pi @Codex look at this",
      targets: ["agent-pi", "agent-codex"],
    })
    await flushMicrotasks()
    await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "multi target",
      targetParticipantIds: ["agent-codex", "agent-pi"],
    })
    await flushMicrotasks()

    const rows = mixpanelBodies(calls).filter(
      (row) => row.event === "TargetedMessage"
    )
    // ONE event per canonical message (two messages, two events) — never
    // one per target. The Human message keeps both agent targets (2-3);
    // the Agent message's self-target is dropped by contract, so it
    // resolves to its single remaining peer target (1).
    expect(rows.length).toBe(2)
    expect(
      rows.filter(
        (row) =>
          (row.properties as Record<string, unknown>).targetCountBucket ===
          "2-3"
      ).length
    ).toBe(1)
    expect(
      rows.filter(
        (row) =>
          (row.properties as Record<string, unknown>).targetCountBucket === "1"
      ).length
    ).toBe(1)
  })

  it("Agent→Human targeted text emits exactly one TargetedMessage with targetKind human", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    const sent = await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "please review this for me",
      targetParticipantIds: ["human-1"],
    })
    expect(sent.status).toBe(200)
    await flushMicrotasks()

    const rows = mixpanelBodies(calls).filter(
      (row) => row.event === "TargetedMessage"
    )
    expect(rows.length).toBe(1)
    expect((rows[0].properties as Record<string, unknown>).senderKind).toBe(
      "agent"
    )
    expect((rows[0].properties as Record<string, unknown>).targetKind).toBe(
      "human"
    )
  })

  it("Agent→Human+Agent mixed targets emit exactly ONE TargetedMessage with targetKind mixed", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    const sent = await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "to both kinds",
      targetParticipantIds: ["human-1", "agent-codex"],
    })
    expect(sent.status).toBe(200)
    await flushMicrotasks()

    const rows = mixpanelBodies(calls).filter(
      (row) => row.event === "TargetedMessage"
    )
    expect(rows.length).toBe(1)
    expect((rows[0].properties as Record<string, unknown>).targetKind).toBe(
      "mixed"
    )
    expect(
      (rows[0].properties as Record<string, unknown>).targetCountBucket
    ).toBe("2-3")
  })

  it("Agent self-target is removed and stale participant ids are removed", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    const sent = await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "self and stale targets",
      targetParticipantIds: ["agent-pi", "ghost-agent", "human-1"],
    })
    expect(sent.status).toBe(200)
    await flushMicrotasks()

    const rows = mixpanelBodies(calls).filter(
      (row) => row.event === "TargetedMessage"
    )
    expect(rows.length).toBe(1)
    expect((rows[0].properties as Record<string, unknown>).targetKind).toBe(
      "human"
    )
    expect(
      (rows[0].properties as Record<string, unknown>).targetCountBucket
    ).toBe("1")
  })

  it("targeting only a Human wakes no Agent waiter (attention, not activation)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control, agentWait } = makeRoomSession(calls, "project-token")
    await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "for the Human only",
      targetParticipantIds: ["human-1"],
    })
    const waited = await agentWait("agent-codex", 0)
    expect(waited.status).toBe(200)
    const events = waited.json.events as Array<{
      addressed: boolean
      text?: string
    }>
    const messageEvent = events.find(
      (event) => event.text === "for the Human only"
    )
    // The message is visible to the Agent as ordinary context...
    expect(messageEvent).toBeTruthy()
    // ...but it is NOT an addressed wake for that Agent.
    expect(messageEvent?.addressed).toBe(false)
  })

  it("unaddressed text emits zero TargetedMessage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control, sendHuman } = makeRoomSession(calls, "project-token")
    await sendHuman({ type: "chat", text: "hello everyone" })
    await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "unaddressed note",
    })
    await flushMicrotasks()
    expect(
      mixpanelBodies(calls).filter((row) => row.event === "TargetedMessage")
    ).toHaveLength(0)
  })

  it("structured collab request emits CollabRequested but never TargetedMessage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    const sent = await control({
      action: "agent-send-collab",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      event: {
        kind: "request",
        targetParticipantId: "agent-codex",
        summary: "please review",
      },
    })
    expect(sent.status).toBe(200)
    await flushMicrotasks()

    const rows = mixpanelBodies(calls)
    expect(rows.filter((row) => row.event === "TargetedMessage")).toHaveLength(
      0
    )
    expect(rows.filter((row) => row.event === "CollabRequested")).toHaveLength(
      1
    )
  })

  it("absent Mixpanel secret makes TargetedMessage a harmless no-op", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls)
    const sent = await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "targeted",
      targetParticipantIds: ["agent-codex"],
    })
    expect(sent.status).toBe(200)
    await flushMicrotasks()
    expect(calls.filter((c) => c.url.includes("mixpanel")).length).toBe(0)
  })

  it("ingestion failure never blocks the targeted text mutation", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { control } = makeRoomSession(calls, "project-token")
    const failing = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 500 }))
    vi.stubGlobal("fetch", failing)
    const sent = await control({
      action: "agent-send-text",
      participantId: "agent-pi",
      token: "tok-agent-pi",
      text: "targeted despite analytics failure",
      targetParticipantIds: ["agent-codex"],
    })
    expect(sent.status).toBe(200)
    const persisted = mixpanelBodies(calls)
    void persisted
  })
})
