import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import { roomAppInstanceId } from "../common/roomApp"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000
const ROOM_NAME = "room-app-unicast-test"
const APP_INSTANCE_ID = roomAppInstanceId(ROOM_NAME, "whiteboard")

function participant(
  id: string,
  kind: "human" | "agent",
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    name: id,
    kind,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `token-${id}`,
    ...(kind === "human"
      ? {
          connectionNonce: `nonce-${id}`,
          media: {
            sessionId: `session-${id}`,
            muted: false,
            fileChannelReady: false,
            tracks: [],
          },
        }
      : {}),
    ...overrides,
  }
}

function buildStoredRoom() {
  return {
    createdAt: Date.now(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-a": participant("human-a", "human"),
      "human-b": participant("human-b", "human"),
      "human-c": participant("human-c", "human"),
      "agent-c": participant("agent-c", "agent"),
    },
    messages: [],
    nextMessageSequence: 1,
    meetingNotes: { active: false },
    agentVoice: {},
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    nextLiveTranscriptEpoch: 1,
    nextTranscriptSequence: 1,
    attachments: [],
    pendingMediaCleanup: [],
  }
}

class FakeSocket {
  readyState = 1
  sent: string[] = []
  send = vi.fn((raw: string) => this.sent.push(raw))
  close = vi.fn()

  constructor(private attachment: Record<string, unknown>) {}

  deserializeAttachment() {
    return this.attachment
  }

  serializeAttachment(attachment: Record<string, unknown>) {
    this.attachment = structuredClone(attachment)
  }

  messages() {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }
}

function makeRoomSession() {
  const store = new Map<string, unknown>([
    ["room", buildStoredRoom()],
    [
      "live-transcript",
      {
        liveTranscript: { active: false },
        liveTranscriptSegments: [],
        nextLiveTranscriptEpoch: 1,
        nextTranscriptSequence: 1,
      },
    ],
  ])
  const sockets: FakeSocket[] = []
  const ctx = {
    storage: {
      get: async (key: string) => {
        const value = store.get(key)
        return value === undefined ? undefined : structuredClone(value)
      },
      put: async (key: string, value: unknown) =>
        void store.set(key, structuredClone(value)),
      delete: async (key: string) => void store.delete(key),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
      list: async () => new Map(),
    },
    getWebSockets: () => sockets as unknown as WebSocket[],
    waitUntil: (promise: Promise<unknown>) => void promise,
    id: { name: ROOM_NAME, toString: () => ROOM_NAME },
  }
  const session = new RoomSession(
    ctx as never,
    { SFU_ROOM: {}, ROOM_APPS_ENABLED: "true" } as never
  )
  const addHumanSocket = (
    participantId: string,
    nonce = `nonce-${participantId}`
  ) => {
    const socket = new FakeSocket({
      participantId,
      token: `token-${participantId}`,
      connectionNonce: nonce,
    })
    sockets.push(socket)
    return socket
  }
  const addAgentSocket = (participantId: string) => {
    const socket = new FakeSocket({
      kind: "agent-event",
      participantId,
      connectionNonce: `nonce-${participantId}`,
      cursor: 0,
    })
    sockets.push(socket)
    return socket
  }
  const sendFrom = async (
    socket: FakeSocket,
    participantId: string,
    requestId: string,
    targetParticipantId: string,
    payload: Record<string, unknown>
  ) => {
    const message = JSON.stringify({
      type: "room-app-unicast",
      requestId,
      targetParticipantId,
      appInstanceId: APP_INSTANCE_ID,
      payload,
    })
    return (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(socket as unknown as WebSocket, message)
  }
  return { session, store, sockets, addHumanSocket, addAgentSocket, sendFrom }
}

describe("RoomSession reliable participant unicast (#377)", () => {
  it("delivers only to the target Human socket without storing or broadcasting the payload", async () => {
    const { store, addHumanSocket, addAgentSocket, sendFrom } =
      makeRoomSession()
    const sender = addHumanSocket("human-a")
    const target = addHumanSocket("human-b")
    const otherHuman = addHumanSocket("human-c")
    const agent = addAgentSocket("agent-c")
    const secretPayload = { type: "secret_word", word: "otter" }

    await sendFrom(sender, "human-a", "request_1", "human-b", secretPayload)

    expect(target.messages()).toEqual([
      {
        type: "room-app-unicast",
        protocolVersion: 1,
        appInstanceId: APP_INSTANCE_ID,
        sourceParticipantId: "human-a",
        payload: secretPayload,
      },
    ])
    expect(sender.messages()).toEqual([
      {
        type: "room-app-unicast-result",
        requestId: "request_1",
        appInstanceId: APP_INSTANCE_ID,
        ok: true,
      },
    ])
    expect(otherHuman.messages()).toEqual([])
    expect(agent.messages()).toEqual([])
    expect(JSON.stringify(store.get("room"))).not.toContain("otter")
    expect(JSON.stringify(store.get("live-transcript"))).not.toContain("otter")
  })

  it("does not queue for a disconnected target and delivers once to its current reconnect socket", async () => {
    const { store, addHumanSocket, sendFrom } = makeRoomSession()
    const sender = addHumanSocket("human-a")
    const staleTargetSocket = addHumanSocket("human-b", "old-nonce-human-b")
    const room = store.get("room") as ReturnType<typeof buildStoredRoom>
    room.participants["human-b"].connected = false
    room.participants["human-b"].connectionNonce = undefined
    store.set("room", room)

    await sendFrom(sender, "human-a", "request_offline", "human-b", {
      type: "secret_word",
      word: "otter",
    })
    expect(staleTargetSocket.messages()).toEqual([])
    expect(sender.messages().at(-1)).toMatchObject({
      type: "room-app-unicast-result",
      requestId: "request_offline",
      ok: false,
      error: "target_unavailable",
    })

    const reconnectedRoom = store.get("room") as ReturnType<
      typeof buildStoredRoom
    >
    reconnectedRoom.participants["human-b"].connected = true
    reconnectedRoom.participants["human-b"].connectionNonce = "new-nonce"
    store.set("room", reconnectedRoom)
    const currentTargetSocket = addHumanSocket("human-b", "new-nonce")

    await sendFrom(sender, "human-a", "request_reconnected", "human-b", {
      type: "secret_word",
      word: "otter",
    })

    expect(staleTargetSocket.messages()).toEqual([])
    expect(currentTargetSocket.messages()).toHaveLength(1)
    expect(currentTargetSocket.messages()[0].payload).toEqual({
      type: "secret_word",
      word: "otter",
    })
  })

  it("rejects stale senders, non-Human targets, invalid payloads, and disabled Room Apps", async () => {
    const { session, store, addHumanSocket, addAgentSocket, sendFrom } =
      makeRoomSession()
    const sender = addHumanSocket("human-a", "stale-sender-nonce")
    const target = addHumanSocket("human-b")
    const agent = addAgentSocket("agent-c")

    await sendFrom(sender, "human-a", "request_stale", "human-b", {
      type: "private",
    })
    expect(target.messages()).toEqual([])
    expect(sender.messages().at(-1)).toMatchObject({
      ok: false,
      error: "invalid_request",
    })

    const validSender = addHumanSocket("human-a")
    await sendFrom(validSender, "human-a", "request_agent", "agent-c", {
      type: "private",
    })
    expect(agent.messages()).toEqual([])
    expect(validSender.messages().at(-1)).toMatchObject({
      ok: false,
      error: "target_unavailable",
    })

    await sendFrom(validSender, "human-a", "request_spoof", "human-b", {
      sourceParticipantId: "human-a",
      type: "private",
    })
    expect(target.messages()).toEqual([])
    expect(validSender.messages().at(-1)).toMatchObject({
      ok: false,
      error: "invalid_request",
    })
    ;(
      session as unknown as { env: { ROOM_APPS_ENABLED: string } }
    ).env.ROOM_APPS_ENABLED = "false"
    await sendFrom(validSender, "human-a", "request_disabled", "human-b", {
      type: "private",
    })
    expect(target.messages()).toEqual([])
    expect(validSender.messages().at(-1)).toMatchObject({
      ok: false,
      error: "app_unavailable",
    })
    expect(JSON.stringify(store.get("room"))).not.toContain("private")
  })

  it("enforces per-sender message and byte limits without falling back to broadcast", async () => {
    const { addHumanSocket, sendFrom } = makeRoomSession()
    const sender = addHumanSocket("human-a")
    const target = addHumanSocket("human-b")
    for (let index = 0; index < 10; index += 1)
      await sendFrom(sender, "human-a", `request_${index}`, "human-b", {
        index,
      })
    await sendFrom(sender, "human-a", "request_limited", "human-b", {
      index: 10,
    })
    expect(target.messages()).toHaveLength(10)
    expect(sender.messages().at(-1)).toMatchObject({
      type: "room-app-unicast-result",
      requestId: "request_limited",
      ok: false,
      error: "rate_limited",
    })
  })

  it("rejects aggregate unicast bytes above the per-sender budget", async () => {
    const { addHumanSocket, sendFrom } = makeRoomSession()
    const sender = addHumanSocket("human-a")
    const target = addHumanSocket("human-b")
    const largePayload = { value: "x".repeat(13_000) }
    for (let index = 0; index < 5; index += 1)
      await sendFrom(
        sender,
        "human-a",
        `large_${index}`,
        "human-b",
        largePayload
      )

    expect(target.messages()).toHaveLength(4)
    expect(sender.messages().at(-1)).toMatchObject({
      type: "room-app-unicast-result",
      requestId: "large_4",
      ok: false,
      error: "rate_limited",
    })
  })
})
