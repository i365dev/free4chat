import { describe, expect, it, vi, afterEach } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #228 extension: exactly ONE CollaborationDuration per continuous
// 2+-participant overlap, closed when count falls below 2. Single-resident
// time, DO lifetime, and empty-room 30-minute retention are never counted.

function agent(id: string) {
  return {
    id,
    name: id,
    kind: "agent" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: `tok-${id}`,
  }
}

function human(id: string) {
  return {
    id,
    name: id,
    kind: "human" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: `${id}-token`,
    media: {
      sessionId: `${id}-session`,
      muted: false,
      fileChannelReady: true,
      tracks: [{ trackName: "mic", kind: "audio" }],
    },
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("CollaborationDuration analytics (#228 extension)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function makeRoomSession(
    seedRoom: Record<string, unknown>,
    fetchCalls: Array<{ url: string; init: RequestInit }>,
    projectToken = "project-token"
  ) {
    const store = new Map<string, unknown>([["room", seedRoom]])
    const ctx = {
      id: { name: "test-room", toString: () => "test-room" },
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
    }
    const fetchImpl = vi.fn(
      (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init: init ?? {} })
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      }
    )
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
      return { status: response.status }
    }
    const sendHuman = (id: string, message: object) =>
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
        { participantId: id, token: `${id}-token`, connectionNonce: "n" },
        message
      )
    const durations = () => (store.get("room") as Record<string, unknown>) ?? {}
    const storedActivity = () =>
      (store.get("room") as { collaborationActivity?: unknown })
        .collaborationActivity
    return { control, sendHuman, storedActivity, store, durations: durations }
  }

  function durationEvents(calls: Array<{ url: string; init: RequestInit }>) {
    return calls
      .filter((c) => c.url.includes("api.mixpanel.com"))
      .map((c) => JSON.parse(c.init.body as string))
      .flat()
      .filter(
        (row: Record<string, unknown>) => row.event === "CollaborationDuration"
      )
      .map(
        (row: Record<string, unknown>) =>
          row.properties as Record<string, unknown>
      )
  }
  function durationProps(
    calls: Array<{ url: string; init: RequestInit }>
  ): Array<Record<string, unknown>> {
    return durationEvents(calls)
  }

  it("A: one Agent alone never opens an interval or emits a duration", async () => {
    const seed = {
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      participants: { "agent-a": agent("agent-a") },
      messages: [],
      nextMessageSequence: 1,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const room = makeRoomSession(seed, calls)
    await room.control({ action: "room-info" })
    await flush()
    expect(durationProps(calls).length).toBe(0)
    expect(room.storedActivity()).toBeUndefined()
  })

  it("B: Agent alone -> Human joins -> Human leaves -> ONE human-agent duration ≈ overlap", async () => {
    const seed = {
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      participants: { "agent-a": agent("agent-a") },
      messages: [],
      nextMessageSequence: 1,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const room = makeRoomSession(seed, calls)

    let now = 1_000_000
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now)

    // Human joins: interval opens.
    now += 1_000
    await room.control({
      action: "register",
      participant: { ...human("human-1"), joinedAt: now },
    })
    expect(room.storedActivity()).toMatchObject({
      startedAt: now,
      sawHuman: true,
      sawAgent: true,
    })

    // Overlap window advances.
    now += 4 * 60 * 1000 // 4 minutes of real collaboration

    // Human leaves: interval closes with ~4 minutes.
    await room.sendHuman("human-1", { type: "leave" })
    await flush()
    const props = durationProps(calls)
    expect(props.length).toBe(1)
    expect(props[0].durationMs).toBeGreaterThanOrEqual(4 * 60 * 1000)
    expect(props[0].durationMs).toBeLessThan(4 * 60 * 1000 + 5_000)
    expect(props[0].collaborationMode).toBe("human-agent")
    expect(props[0].participantBucket).toBe("2-3")
    expect(room.storedActivity()).toBeUndefined()

    dateSpy.mockRestore()
  })

  it("C: two Agents -> one departs -> ONE agent-only duration", async () => {
    const seed = {
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      participants: {
        "agent-a": agent("agent-a"),
        "agent-b": agent("agent-b"),
      },
      collaborationActivity: {
        startedAt: 2_000_000,
        sawHuman: false,
        sawAgent: true,
        peakParticipantCount: 2,
      },
      messages: [],
      nextMessageSequence: 1,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const room = makeRoomSession(seed, calls)

    let now = 2_060_000
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now)

    now += 60_000
    await room.control({
      action: "agent-leave",
      participantId: "agent-b",
      token: "tok-agent-b",
    })
    await flush()
    const props = durationProps(calls)
    expect(props.length).toBe(1)
    expect(props[0].collaborationMode).toBe("agent-only")
    expect(props[0].durationMs).toBeGreaterThanOrEqual(60_000)
    expect(room.storedActivity()).toBeUndefined()
    dateSpy.mockRestore()
  })

  it("D: two Humans -> one departs -> ONE human-only duration", async () => {
    const seed = {
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      participants: {
        "human-a": human("human-a"),
        "human-b": human("human-b"),
      },
      collaborationActivity: {
        startedAt: 3_000_000,
        sawHuman: true,
        sawAgent: false,
        peakParticipantCount: 2,
      },
      messages: [],
      nextMessageSequence: 1,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const room = makeRoomSession(seed, calls)

    let now = 3_120_000
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    now += 120_000
    await room.sendHuman("human-b", { type: "leave" })
    await flush()
    const props = durationProps(calls)
    expect(props.length).toBe(1)
    expect(props[0].collaborationMode).toBe("human-only")
    dateSpy.mockRestore()
  })

  it("E: DO state reload preserves the OPEN interval (original startedAt, no reset)", async () => {
    const startedAt = 5_000_000
    const seed = {
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      participants: {
        "agent-a": agent("agent-a"),
        "human-a": human("human-a"),
      },
      collaborationActivity: {
        startedAt,
        sawHuman: true,
        sawAgent: true,
        peakParticipantCount: 2,
      },
      messages: [],
      nextMessageSequence: 1,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const room = makeRoomSession(seed, calls)

    let now = startedAt + 120_000
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now)

    // A mutation loads the persisted room; the interval must survive with
    // its ORIGINAL startedAt and not re-open.
    await room.control({ action: "room-info" })
    await room.sendHuman("human-a", { type: "leave" })
    await flush()
    const props = durationProps(calls)
    expect(props.length).toBe(1)
    expect(props[0].durationMs).toBeGreaterThanOrEqual(120_000)
    dateSpy.mockRestore()
  })

  it("F: third participant joins/leaves while count stays >=2: one interval, peak bucket reflects peak", async () => {
    const seed = {
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      participants: {
        "human-a": human("human-a"),
        "agent-a": agent("agent-a"),
      },
      collaborationActivity: {
        startedAt: 6_000_000,
        sawHuman: true,
        sawAgent: true,
        peakParticipantCount: 2,
      },
      messages: [],
      nextMessageSequence: 1,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const room = makeRoomSession(seed, calls)

    let now = 6_100_000
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now)

    // Third participant joins: peak becomes 3, interval continues silently.
    now += 30_000
    await room.control({
      action: "agent-register",
      participant: { ...agent("agent-b"), joinedAt: now },
    })
    let props = durationProps(calls)
    expect(props.length).toBe(0)
    expect(
      (room.storedActivity() as unknown as Record<string, number>)
        .peakParticipantCount
    ).toBe(3)

    // Third participant leaves: count stays 2, interval still open, silent.
    now += 10_000
    await room.control({
      action: "agent-leave",
      participantId: "agent-b",
      token: "tok-agent-b",
    })
    props = durationProps(calls)
    expect(props.length).toBe(0)
    expect(room.storedActivity()).toMatchObject({ peakParticipantCount: 3 })

    // Human departs: count falls to 1 -> ONE duration with peak bucket 2-3.
    now += 10_000
    await room.sendHuman("human-a", { type: "leave" })
    props = durationProps(calls)
    expect(props.length).toBe(1)
    expect(props[0].participantBucket).toBe("2-3")
    dateSpy.mockRestore()
  })

  it("G: 2 -> 1 closes the interval; back to 2 opens a SECOND independent interval", async () => {
    const seed = {
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      participants: {
        "human-a": human("human-a"),
        "agent-a": agent("agent-a"),
      },
      collaborationActivity: {
        startedAt: 7_000_000,
        sawHuman: true,
        sawAgent: true,
        peakParticipantCount: 2,
      },
      messages: [],
      nextMessageSequence: 1,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const room = makeRoomSession(seed, calls)

    let now = 7_030_000
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now)

    // First interval closes when the Human departs (30s overlap).
    await room.sendHuman("human-a", { type: "leave" })
    expect(durationProps(calls).length).toBe(1)

    // Later arrival re-opens a NEW interval (fresh startedAt = now); its
    // departure emits again with a LONGER durationMs (45s overlap).
    now += 120_000
    await room.control({
      action: "register",
      participant: { ...human("human-b"), joinedAt: now },
    })
    expect(room.storedActivity()).toMatchObject({ startedAt: now })

    now += 45_000
    await room.sendHuman("human-b", { type: "leave" })
    await flush()
    const props = durationProps(calls)
    expect(props.length).toBe(2)
    expect(Number(props[1].durationMs)).toBeGreaterThan(
      Number(props[0].durationMs)
    )
    dateSpy.mockRestore()
  })

  it("H: empty-room retention time is never counted", async () => {
    const seed = {
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      participants: {
        "human-a": human("human-a"),
        "agent-a": agent("agent-a"),
      },
      collaborationActivity: {
        startedAt: 8_000_000,
        sawHuman: true,
        sawAgent: true,
        peakParticipantCount: 2,
      },
      messages: [],
      nextMessageSequence: 1,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const room = makeRoomSession(seed, calls)

    let now = 8_000_000
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now)

    // Both depart in the same mutation window: the interval closes as soon
    // as the count falls below 2 — the empty-room 30-minute retention that
    // FOLLOWS is never added (no second event, durationMs bounded).
    now += 300_000
    await room.control({
      action: "agent-leave",
      participantId: "agent-a",
      token: "tok-agent-a",
    })
    await room.sendHuman("human-a", { type: "leave" })
    await flush()
    const props = durationProps(calls)
    expect(props.length).toBe(1)
    expect(Number(props[0].durationMs)).toBe(300_000)
    expect(room.storedActivity()).toBeUndefined()

    // Empty-room cleanup alarm running later emits nothing further.
    now += 30 * 60 * 1000
    dateSpy.mockRestore()
  })
})
