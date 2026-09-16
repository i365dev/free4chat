import { afterEach, describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

// #406: bound-of-last-resort coverage for anonymous/cheap admission. These
// tests exist to keep the *cause* of billable cost removed, not to assert a
// particular accounting:
//
//   - wait_for_events must not hold an HTTP request (and therefore a
//     setTimeout) unless the legacy long-poll is explicitly opted into, and
//     must never be chainable into a permanently awake Room;
//   - Room membership and the primary Room record are hard-bounded;
//   - one participant capability cannot open or send without limit.

const TOKEN = (id: string) => `${id}-token`

function participant(id: string, kind: "human" | "agent") {
  return {
    id,
    name: id,
    kind,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: TOKEN(id),
    ...(kind === "human"
      ? {
          media: {
            sessionId: `${id}-session`,
            muted: false,
            fileChannelReady: false,
            tracks: [],
          },
        }
      : {}),
  }
}

function roomFixture(): RoomRecord {
  return {
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    participants: {
      human: participant("human", "human"),
      agent: participant("agent", "agent"),
    },
    messages: [],
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    nextLiveTranscriptEpoch: 1,
    nextTranscriptSequence: 1,
    attachments: [],
    nextMessageSequence: 0,
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

class TestSocket {
  attachment: unknown = null
  sent: string[] = []
  closed: Array<{ code: number; reason: string }> = []

  serializeAttachment(value: unknown) {
    this.attachment = value
  }

  deserializeAttachment() {
    return this.attachment
  }

  send(value: string) {
    this.sent.push(value)
  }

  close(code: number, reason: string) {
    this.closed.push({ code, reason })
  }
}

function harness(
  env: Record<string, unknown> = {},
  options: { sockets?: TestSocket[] } = {}
) {
  const fixture = roomFixture()
  const store = new Map<string, unknown>([["room", fixture]])
  const sockets = options.sockets ?? []
  const ctx = {
    id: { name: "cost-bounds-room", toString: () => "cost-bounds-room" },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string | string[]) => {
        for (const entry of Array.isArray(key) ? key : [key])
          store.delete(entry)
      },
      list: async () => new Map(),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
      deleteAll: async () => store.clear(),
    },
    getWebSockets: () => sockets as unknown as WebSocket[],
    acceptWebSocket: vi.fn(),
    waitUntil: (promise: Promise<unknown>) => void promise,
  }
  const session = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      AGENT_MEDIA_ENABLED: "false",
      ...env,
    } as never
  )
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
  const storedRoom = () => store.get("room") as Record<string, unknown>
  // The first load normalizes (and persists) a seeded record, so mutations are
  // compared against a post-load baseline instead of the raw seed.
  const snapshot = () => {
    const room = storedRoom()
    return {
      bytes: storedBytes(room),
      participantIds: Object.keys(room.participants as object).sort(),
      messageCount: (room.messages as unknown[]).length,
      nextMessageSequence: room.nextMessageSequence,
    }
  }
  const settle = () => control({ action: "room-info" })
  // The real WebSocket entry point, so the shaped protocol errors a browser
  // receives are what is asserted.
  const sendSocketMessage = (socket: TestSocket, message: unknown) => {
    socket.serializeAttachment({
      participantId: "human",
      token: TOKEN("human"),
      connectionNonce: "nonce-1",
    })
    return session.webSocketMessage(socket as never, JSON.stringify(message))
  }
  return {
    session,
    control,
    store,
    storedRoom,
    snapshot,
    settle,
    ctx,
    sendSocketMessage,
  }
}

function storedBytes(room: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(room)).byteLength
}

function agentWait(overrides: Record<string, unknown> = {}) {
  return {
    action: "agent-wait",
    participantId: "agent",
    token: TOKEN("agent"),
    cursor: 0,
    timeoutSeconds: 25,
    ...overrides,
  }
}

const PRIMARY_BUDGET_BYTES = 80 * 1024
const MAX_PARTICIPANTS = 32
const MAX_MESSAGES_PER_WINDOW = 300

describe("#406 wait_for_events does not pin RoomSession duration", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns immediately by default and leaves no non-hibernatable timer", async () => {
    vi.useFakeTimers()
    const { control, session } = harness()

    const result = await control(agentWait())

    expect(result.status).toBe(200)
    expect(result.json.longPoll).toBe("immediate")
    expect(result.json.retryAfterMs).toBeGreaterThan(0)
    // The decisive assertion: a default wait leaves nothing that prevents
    // hibernation — no setTimeout, no parked waiter, no in-flight request.
    expect(vi.getTimerCount()).toBe(0)
    expect(
      (session as unknown as { agentWaiters: Map<string, unknown> })
        .agentWaiters.size
    ).toBe(0)
  })

  it("only holds a clamped legacy window under the explicit opt-in, and never chains holds", async () => {
    vi.useFakeTimers()
    const { control } = harness({ MCP_LONGPOLL_ENABLED: "true" })

    const holding = control(agentWait())
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)

    // Still parked just before the clamp, so the requested 25s was NOT used.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    const held = await holding
    expect(held.json.longPoll).toBe("held")
    expect(vi.getTimerCount()).toBe(0)

    // A second hold inside the per-Room gap is refused immediately: the Room
    // can never be kept awake by chaining waits, because every hold is
    // followed by an idle window long enough for hibernation.
    const chained = await control(agentWait())
    expect(chained.json.longPoll).toBe("cooling_down")
    expect(chained.json.retryAfterMs).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("still refreshes the Agent lease without holding the request", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const { control, storedRoom } = harness()
    const before = (
      (storedRoom().participants as Record<string, { lastSeenAt: number }>)
        .agent ?? { lastSeenAt: 0 }
    ).lastSeenAt

    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"))
    const result = await control(agentWait())

    expect(result.status).toBe(200)
    const after = (
      (storedRoom().participants as Record<string, { lastSeenAt: number }>)
        .agent ?? { lastSeenAt: 0 }
    ).lastSeenAt
    expect(after).toBeGreaterThan(before)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("#406 Room membership is hard-bounded", () => {
  it("rejects fresh Human and Agent admission at capacity, while reconnect and duplicates still work", async () => {
    const { control, storedRoom } = harness()

    for (let index = 2; index < MAX_PARTICIPANTS; index += 1) {
      const registered = await control({
        action: "agent-register",
        participant: {
          id: `agent-${index}`,
          name: `Agent ${index}`,
          kind: "agent",
          joinedAt: Date.now(),
          token: `agent-${index}-token`,
        },
      })
      expect(registered.status).toBe(200)
    }
    expect(Object.keys(storedRoom().participants as object)).toHaveLength(
      MAX_PARTICIPANTS
    )

    const human = await control({
      action: "register",
      participant: {
        id: "human-extra",
        name: "Human Extra",
        kind: "human",
        joinedAt: Date.now(),
        token: "human-extra-token",
        media: {
          sessionId: "session-extra",
          muted: false,
          fileChannelReady: false,
          tracks: [],
        },
      },
    })
    expect(human.status).toBe(409)
    expect(human.json.error).toBe("room_full")

    const agent = await control({
      action: "agent-register",
      participant: {
        id: "agent-extra",
        name: "Agent Extra",
        kind: "agent",
        joinedAt: Date.now(),
        token: "agent-extra-token",
      },
    })
    expect(agent.status).toBe(409)
    expect(agent.json.error).toBe("room_full")

    // A duplicate id is still reported as such, never as capacity.
    const duplicate = await control({
      action: "register",
      participant: {
        id: "human",
        name: "Human",
        kind: "human",
        joinedAt: Date.now(),
        token: TOKEN("human"),
        media: {
          sessionId: "session-extra",
          muted: false,
          fileChannelReady: false,
          tracks: [],
        },
      },
    })
    expect(duplicate.json.error).toBe("participant_exists")

    // Reconnecting an existing participant adds no participant and must never
    // be blocked by the capacity check.
    const reconnect = await control({
      action: "reconnect",
      participantId: "human",
      token: TOKEN("human"),
      sessionId: "human-session",
      newSessionId: "human-session-2",
    })
    expect(reconnect.status).toBe(200)
  })
})

describe("#406 primary Room record stays inside its byte budget", () => {
  it("evicts bounded history instead of letting a long conversation exceed the budget", async () => {
    const { control, storedRoom } = harness()

    for (let index = 0; index < 40; index += 1) {
      const sent = await control({
        action: "agent-send-text",
        participantId: "agent",
        token: TOKEN("agent"),
        // 2000 CJK characters ≈ 6 KB per message: 40 of them are well past
        // the 80 KiB budget if nothing evicts.
        text: "语".repeat(2_000),
      })
      expect(sent.status).toBe(200)
      expect(storedBytes(storedRoom())).toBeLessThanOrEqual(
        PRIMARY_BUDGET_BYTES
      )
    }

    const messages = storedRoom().messages as unknown[]
    expect(messages.length).toBeGreaterThan(1)
    expect(messages.length).toBeLessThan(40)
  })

  it("rejects an unfittable mutation with a shaped protocol error and preserves stored state", async () => {
    const { sendSocketMessage, settle, snapshot } = harness()
    await settle()
    const before = snapshot()
    const socket = new TestSocket()

    await sendSocketMessage(socket, {
      type: "action",
      actionType: "oversized-test-action",
      // Legal public input: the client may send an arbitrary action payload,
      // which no eviction order can shrink.
      actionPayload: { data: "x".repeat(200_000) },
    })

    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      type: "error",
      error: "room_state_budget_exceeded",
    })
    expect(snapshot()).toEqual(before)
    expect(before.bytes).toBeLessThanOrEqual(PRIMARY_BUDGET_BYTES)
  })

  it("answers an oversized control mutation with a shaped 507", async () => {
    const { control, settle, snapshot } = harness()
    await settle()
    const before = snapshot()

    const registered = await control({
      action: "agent-register",
      participant: {
        id: "agent-huge",
        // The DO is the last line of defense: callers bound names, but a
        // direct control request can still try to persist an oversized one.
        name: "n".repeat(100_000),
        kind: "agent",
        joinedAt: Date.now(),
        token: "agent-huge-token",
      },
    })

    expect(registered.status).toBe(507)
    expect(registered.json.error).toBe("room_state_budget_exceeded")
    expect(snapshot()).toEqual(before)
  })
})

describe("#406 connection and message amplification is bounded", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("replaces a participant's older sockets at their own cap instead of locking them out", async () => {
    const sockets = Array.from({ length: 4 }, () => {
      const socket = new TestSocket()
      socket.serializeAttachment({
        participantId: "human",
        token: TOKEN("human"),
        connectionNonce: "nonce-1",
      })
      return socket
    })
    const { session } = harness({}, { sockets })
    const pair = [new TestSocket(), new TestSocket()] as const
    class WebSocketPairMock {
      0 = pair[0]
      1 = pair[1]
    }
    class UpgradeResponse extends Response {
      constructor(
        body?: BodyInit | null,
        init?: ResponseInit & { webSocket?: unknown }
      ) {
        if (init?.status === 101) {
          super(null, { status: 200 })
          Object.defineProperty(this, "status", { value: 101 })
          return
        }
        super(body, init)
      }
    }
    vi.stubGlobal("WebSocketPair", WebSocketPairMock)
    vi.stubGlobal("Response", UpgradeResponse)

    const response = await session.fetch(
      new Request(
        `https://room/ws?participantId=human&token=${TOKEN("human")}`,
        { method: "GET", headers: { Upgrade: "websocket" } }
      )
    )

    expect(response.status).toBe(101)
    for (const socket of sockets)
      expect(socket.closed).toContainEqual({ code: 4000, reason: "Replaced" })
  })

  it("rejects a new browser socket when the Room is already at its socket cap", async () => {
    const sockets = Array.from({ length: 64 }, () => {
      const socket = new TestSocket()
      socket.serializeAttachment({
        participantId: "human",
        token: TOKEN("human"),
        connectionNonce: "nonce-1",
      })
      return socket
    })
    const { session } = harness({}, { sockets })

    const response = await session.fetch(
      new Request(
        "https://room/ws?participantId=human&token=" + TOKEN("human"),
        {
          method: "GET",
          headers: { Upgrade: "websocket" },
        }
      )
    )

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: "room_connection_limit" })
  })

  it("rate-limits one participant's client messages without touching Room state", async () => {
    const { sendSocketMessage, settle, snapshot } = harness()
    await settle()
    const before = snapshot()
    const socket = new TestSocket()

    for (let index = 0; index < MAX_MESSAGES_PER_WINDOW; index += 1)
      await sendSocketMessage(socket, { type: "resync" })
    expect(
      socket.sent.some(
        (payload) => JSON.parse(payload).error === "message_rate_limited"
      )
    ).toBe(false)

    await sendSocketMessage(socket, { type: "resync" })

    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      type: "error",
      error: "message_rate_limited",
    })
    expect(snapshot()).toEqual(before)
  })
})
