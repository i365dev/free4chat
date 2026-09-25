import { afterEach, describe, expect, it, vi } from "vitest"

import { isAnalyticsRoomId } from "./roomAnalytics"
import { RoomSession } from "./RoomSession"
import type { RoomRecord, RoomState } from "../room/types"

/**
 * #346: ONE analyticsRoomId per canonical Room generation.
 *
 * These tests pin the Room-side lifecycle that the rest of the analytics
 * schema depends on:
 *
 *   - minted once with the generation, never derived from the Room name;
 *   - persisted with RoomRecord, so eviction/restart cannot change it;
 *   - backfilled exactly once for a Room stored before the field existed;
 *   - projected to a connected browser unchanged, so browser and server
 *     Room-scoped events share one correlation key;
 *   - replaced — never reused — when the same human-readable Room name
 *     becomes a new generation.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function humanParticipant(id: string) {
  return {
    id,
    name: id,
    kind: "human" as const,
    joinedAt: 1,
    token: `${id}-token`,
    media: {
      sessionId: `${id}-session`,
      muted: false,
      fileChannelReady: false,
      tracks: [],
    },
  }
}

/** A Room record exactly as an OLDER build persisted it: no analyticsRoomId. */
function legacyStoredRoom(): Record<string, unknown> {
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
        capabilities: { text: true },
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

function harness(options: { storedRoom?: unknown } = {}) {
  const store = new Map<string, unknown>(
    options.storedRoom === undefined ? [] : [["room", options.storedRoom]]
  )
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
      },
      deleteAll: async () => void store.clear(),
      list: async (options: { prefix: string }) =>
        new Map(
          [...store.entries()].filter(([key]) => key.startsWith(options.prefix))
        ),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [] as WebSocket[],
    waitUntil: (promise: Promise<unknown>) => void promise,
    id: { name: "recycled-room-name", toString: () => "recycled-room-name" },
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

  const newSession = () =>
    new RoomSession(
      ctx as never,
      {
        SFU_ROOM: {},
        AGENT_MEDIA_ENABLED: "true",
        MIXPANEL_PROJECT_TOKEN: "project-token",
      } as never
    )
  const session = newSession()
  const control = async (body: Record<string, unknown>) => {
    const response = await session.fetch(
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
  return {
    session,
    /** A brand-new RoomSession over the SAME storage: a DO eviction/restart. */
    newSession,
    control,
    store,
    fetchCalls,
    storedRoom: () => store.get("room") as RoomRecord | undefined,
  }
}

function mixpanelBodies(calls: Array<{ url: string; init: RequestInit }>) {
  return calls
    .filter((call) => call.url.includes("api.mixpanel.com"))
    .map((call) => JSON.parse(call.init.body as string))
    .flat() as Array<{ event: string; properties: Record<string, unknown> }>
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function registerHuman(
  control: (body: Record<string, unknown>) => Promise<{
    status: number
    json: Record<string, unknown>
  }>,
  id: string
) {
  const result = await control({
    action: "register",
    participant: humanParticipant(id),
  })
  return result
}

describe("analyticsRoomId lifecycle (#346)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("mints exactly one random id with a new generation and persists it", async () => {
    const test = harness()
    const result = await registerHuman(test.control, "human-a")
    expect(result.status).toBe(200)

    const state = result.json.state as RoomState
    expect(isAnalyticsRoomId(state.analyticsRoomId)).toBe(true)
    // Persisted with the generation, not invented at projection time.
    expect(test.storedRoom()?.analyticsRoomId).toBe(state.analyticsRoomId)
    // Never derived from the Room name, and not the legacy hash convention.
    expect(state.analyticsRoomId).not.toContain("recycled-room-name")
    expect(state.analyticsRoomId).not.toBe(
      mixpanelBodies(test.fetchCalls).find((row) => row.event === "RoomCreated")
        ?.properties.roomHash
    )
  })

  it("gives RoomCreated the SAME id the persisted generation carries", async () => {
    const test = harness()
    const result = await registerHuman(test.control, "human-a")
    await flushMicrotasks()

    const state = result.json.state as RoomState
    const created = mixpanelBodies(test.fetchCalls).filter(
      (row) => row.event === "RoomCreated"
    )
    expect(created).toHaveLength(1)
    expect(created[0].properties.analyticsRoomId).toBe(state.analyticsRoomId)
    expect(created[0].properties.roomHash).toBeTruthy()
    // Dual-write: the historical property stays alongside the new key.
    expect(Object.keys(created[0].properties)).toContain("roomHash")
  })

  it("keeps one stable id across DO eviction/restart", async () => {
    const test = harness()
    const first = await registerHuman(test.control, "human-a")
    const minted = (first.json.state as RoomState).analyticsRoomId

    // A new DO instance over the same storage — exactly what eviction does.
    const revived = test.newSession()
    const response = await revived.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify({
          action: "register",
          participant: humanParticipant("human-b"),
        }),
      })
    )
    const body = (await response.json()) as { state: RoomState }
    expect(body.state.analyticsRoomId).toBe(minted)
    expect(test.storedRoom()?.analyticsRoomId).toBe(minted)
  })

  it("backfills an existing Room stored before the field existed, exactly once", async () => {
    const test = harness({ storedRoom: legacyStoredRoom() })
    expect(test.storedRoom()).not.toHaveProperty("analyticsRoomId")

    const result = await registerHuman(test.control, "human-a")
    const backfilled = (result.json.state as RoomState).analyticsRoomId
    expect(isAnalyticsRoomId(backfilled)).toBe(true)
    // The healed record is actually persisted, not only projected.
    expect(test.storedRoom()?.analyticsRoomId).toBe(backfilled)

    // Every later load — including one from a fresh instance — reuses it
    // instead of regenerating.
    const revived = test.newSession()
    const response = await revived.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify({
          action: "register",
          participant: humanParticipant("human-b"),
        }),
      })
    )
    const body = (await response.json()) as { state: RoomState }
    expect(body.state.analyticsRoomId).toBe(backfilled)
  })

  it("replaces a corrupted stored value once instead of trusting it", async () => {
    const test = harness({
      storedRoom: { ...legacyStoredRoom(), analyticsRoomId: "not-a-uuid" },
    })
    const result = await registerHuman(test.control, "human-a")
    const healed = (result.json.state as RoomState).analyticsRoomId
    expect(isAnalyticsRoomId(healed)).toBe(true)
    expect(test.storedRoom()?.analyticsRoomId).toBe(healed)
  })

  it("gives the same Room name a DIFFERENT id after the generation expires", async () => {
    const test = harness()
    const first = await registerHuman(test.control, "human-a")
    const firstId = (first.json.state as RoomState).analyticsRoomId

    // Expire the generation: storage is deleted, so the id disappears with
    // it. The DO instance (and therefore the human-readable name) is reused.
    const stored = test.storedRoom() as RoomRecord
    stored.expiresAt = Date.now() - 1
    test.store.set("room", stored)
    const expired = await registerHuman(test.control, "human-b")
    expect(expired.status).toBe(410)
    expect(test.store.has("room")).toBe(false)

    // The same name created again is a NEW canonical generation.
    const second = await registerHuman(test.control, "human-c")
    expect(second.status).toBe(200)
    const secondId = (second.json.state as RoomState).analyticsRoomId
    expect(isAnalyticsRoomId(secondId)).toBe(true)
    expect(secondId).not.toBe(firstId)
  })

  it("projects the browser RoomState id from the canonical record only", async () => {
    const test = harness()
    const first = await registerHuman(test.control, "human-a")
    const canonical = (first.json.state as RoomState).analyticsRoomId

    // A second browser joining the SAME generation observes the same key.
    const second = await registerHuman(test.control, "human-b")
    expect((second.json.state as RoomState).analyticsRoomId).toBe(canonical)

    // And no projection ever carries the raw Room name in that field.
    expect(canonical).not.toContain("recycled-room-name")
  })
})
