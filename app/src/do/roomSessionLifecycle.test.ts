import { afterEach, describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

function expiredRoom(): RoomRecord {
  const now = Date.now()
  return {
    createdAt: now - 60_000,
    expiresAt: now - 1,
    participants: {
      agent: {
        id: "agent",
        name: "Agent",
        kind: "agent",
        connected: true,
        joinedAt: now - 60_000,
        lastSeenAt: now - 50_000,
        token: "agent-token",
      },
    },
    messages: [
      {
        id: "message-1",
        peerId: "agent",
        name: "Agent",
        kind: "agent",
        type: "text",
        text: "old room data",
        createdAt: now - 30_000,
        sequence: 1,
      },
    ],
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    nextLiveTranscriptEpoch: 1,
    nextTranscriptSequence: 1,
    attachments: [
      {
        id: "attachment-1",
        senderId: "agent",
        senderName: "Agent",
        senderKind: "agent",
        mimeType: "text/plain",
        fileName: "old.txt",
        size: 3,
        chunkCount: 1,
        createdAt: now - 30_000,
        sequence: 2,
      },
    ],
    nextMessageSequence: 2,
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [{ sessionId: "old-session", mids: ["old-mid"] }],
  }
}

function lifecycleHarness() {
  const room = expiredRoom()
  const store = new Map<string, unknown>([
    ["room", room],
    ["live-transcript", { stale: true }],
    ["surface:orphan:0", new Uint8Array([1])],
    ["attachment:attachment-1:0", new Uint8Array([1, 2, 3])],
    ["future-unknown-key", "must be removed"],
  ])
  const order: string[] = []
  const socket = {
    send: vi.fn(),
    close: vi.fn(),
    deserializeAttachment: vi.fn(() => null),
  } as unknown as WebSocket
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (keys: string | string[]) => {
        order.push("delete")
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
      },
      list: async ({ prefix }: { prefix?: string }) =>
        new Map(
          [...store.entries()].filter(([key]) =>
            prefix === undefined ? true : key.startsWith(prefix)
          )
        ),
      setAlarm: async () => undefined,
      deleteAlarm: async () => {
        order.push("deleteAlarm")
      },
      getAlarm: async () => undefined,
      deleteAll: async () => {
        order.push("deleteAll")
        store.clear()
      },
    },
    getWebSockets: () => [socket],
  }
  const session = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      SFU_APP_ID: "app-id",
      SFU_APP_SECRET: "app-secret",
    } as never
  )
  return { session, room, store, order, socket }
}

class TestAgentEventSocket {
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

function agentEventRoom(): RoomRecord {
  const now = Date.now()
  return {
    createdAt: now,
    expiresAt: now + 60_000,
    participants: {
      human: {
        id: "human",
        name: "Human",
        kind: "human",
        connected: true,
        joinedAt: now,
        lastSeenAt: now,
        token: "human-token",
      },
      agent: {
        id: "agent",
        name: "Agent",
        kind: "agent",
        connected: true,
        joinedAt: now,
        lastSeenAt: now,
        token: "agent-token",
      },
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

describe("RoomSession expiry cleanup", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("deletes the alarm and all storage after snapshotting cleanup effects", async () => {
    const { session, room, store, order, socket } = lifecycleHarness()
    const closeFetch = vi.fn(async () => {
      expect(store.size).toBe(0)
      order.push("mediaClose")
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal("fetch", closeFetch)

    let waiterResponse: Response | undefined
    const timer = setTimeout(() => undefined, 10_000)
    ;(
      session as unknown as { agentWaiters: Map<string, unknown> }
    ).agentWaiters.set("agent", {
      participantId: "agent",
      cursor: 0,
      timer,
      resolve: (response: Response) => {
        waiterResponse = response
        order.push("waiter")
      },
    })

    await (
      session as unknown as {
        expireRoom: (room: RoomRecord) => Promise<void>
      }
    ).expireRoom(room)

    expect(store.size).toBe(0)
    expect(order.indexOf("deleteAlarm")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("deleteAll")).toBeGreaterThan(
      order.indexOf("deleteAlarm")
    )
    expect(order.indexOf("mediaClose")).toBeGreaterThan(
      order.indexOf("deleteAll")
    )
    expect(order.indexOf("waiter")).toBeGreaterThan(order.indexOf("mediaClose"))
    expect(closeFetch).toHaveBeenCalledOnce()
    expect(JSON.parse(await waiterResponse!.text())).toMatchObject({
      expired: true,
      cursor: 2,
    })
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "expired" })
    )
    expect(socket.close).toHaveBeenCalledWith(4001, "Room expired")
  })

  it("allows a fresh create to start without any prior-generation keys", async () => {
    const { session, room, store } = lifecycleHarness()
    await (
      session as unknown as {
        expireRoom: (room: RoomRecord) => Promise<void>
      }
    ).expireRoom(room)

    const response = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify({
          action: "agent-create-room",
          participant: {
            id: "new-agent",
            name: "New Agent",
            kind: "agent",
            token: "new-token",
            joinedAt: Date.now(),
            capabilities: { advertised: [] },
          },
        }),
      })
    )
    expect(response.status).toBe(200)
    const fresh = store.get("room") as RoomRecord
    expect(Object.keys(fresh.participants)).toEqual(["new-agent"])
    expect(fresh.messages).toEqual([])
    expect(store.get("live-transcript")).not.toEqual({ stale: true })
    expect(store.has("future-unknown-key")).toBe(false)
  })

  it("authenticates, reconnects, and delivers canonical events on the hibernatable socket", async () => {
    const NativeResponse = Response
    class UpgradeResponse extends NativeResponse {
      constructor(
        body?: BodyInit | null,
        init?: ResponseInit & { webSocket?: unknown }
      ) {
        if (init?.status === 101) {
          super(null, { status: 200 })
          Object.defineProperty(this, "status", { value: 101 })
          ;(this as unknown as { webSocket?: unknown }).webSocket =
            init.webSocket
          return
        }
        super(body, init)
      }
    }
    vi.stubGlobal("Response", UpgradeResponse)

    const store = new Map<string, unknown>([["room", agentEventRoom()]])
    const sockets: TestAgentEventSocket[] = []
    const tags = new Map<TestAgentEventSocket, string[]>()
    const ctx = {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys])
            store.delete(key)
        },
        list: async () => new Map(),
        setAlarm: async () => undefined,
        deleteAlarm: async () => undefined,
        getAlarm: async () => undefined,
        deleteAll: async () => store.clear(),
      },
      getWebSockets: (tag?: string) =>
        tag === undefined
          ? sockets
          : sockets.filter((socket) => tags.get(socket)?.includes(tag)),
      acceptWebSocket: vi.fn(
        (socket: TestAgentEventSocket, socketTags: string[]) => {
          sockets.push(socket)
          tags.set(socket, socketTags)
        }
      ),
    }
    const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
    const first = {
      0: new TestAgentEventSocket(),
      1: new TestAgentEventSocket(),
    }
    const second = {
      0: new TestAgentEventSocket(),
      1: new TestAgentEventSocket(),
    }
    vi.stubGlobal(
      "WebSocketPair",
      vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    )
    const request = () =>
      new Request("https://room/agent-events", {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          "X-Room-Participant-Id": "agent",
          Authorization: "Bearer agent-token",
          "X-Room-Cursor": "0",
        },
      })

    const firstResponse = await (
      session as unknown as {
        handleAgentEventConnection: (request: Request) => Promise<Response>
      }
    ).handleAgentEventConnection(request())
    expect(firstResponse.status).toBe(101)
    expect(first[1].attachment).toMatchObject({
      kind: "agent-event",
      participantId: "agent",
    })
    expect(first[1].attachment).not.toHaveProperty("token")
    expect(JSON.parse(first[1].sent[0])).toMatchObject({
      type: "events",
      cursor: 0,
    })

    const secondResponse = await (
      session as unknown as {
        handleAgentEventConnection: (request: Request) => Promise<Response>
      }
    ).handleAgentEventConnection(request())
    expect(secondResponse.status).toBe(101)
    expect(first[1].closed).toContainEqual({ code: 4000, reason: "Replaced" })

    // A delayed close from the replaced socket cannot revoke the new nonce.
    await session.webSocketClose(first[1] as never, 4000, "Replaced", true)
    let current = store.get("room") as RoomRecord
    expect(current.participants.agent.connected).toBe(true)

    await session.webSocketMessage(
      second[1] as never,
      JSON.stringify({ type: "heartbeat", cursor: 0 })
    )
    current = store.get("room") as RoomRecord
    expect(current.participants.agent.connected).toBe(true)
    expect(current.nextMessageSequence).toBe(0)

    current.messages.push({
      id: "message-1",
      peerId: "human",
      name: "Human",
      kind: "human",
      type: "text",
      text: "hello",
      createdAt: Date.now(),
      sequence: 1,
    })
    current.nextMessageSequence = 1
    ;(
      session as unknown as {
        resolveAgentWaiters: (room: RoomRecord) => void
      }
    ).resolveAgentWaiters(current)
    const eventEnvelope = JSON.parse(second[1].sent.at(-1) ?? "{}")
    expect(eventEnvelope.events).toHaveLength(1)
    expect(eventEnvelope.events[0]).toMatchObject({
      sequence: 1,
      text: "hello",
    })

    await session.webSocketClose(second[1] as never, 1000, "closed", true)
    current = store.get("room") as RoomRecord
    expect(current.participants.agent.connected).toBe(false)
  })
})
