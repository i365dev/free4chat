import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import {
  EMPTY_ROOM_APP_CATALOG,
  ROOM_APP_CATALOG_REFRESH_INTERVAL_MS,
  ROOM_APP_CATALOG_ENDPOINT,
  roomAppInstanceId,
  setProductionRoomAppCatalog,
} from "../common/roomApp"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000
const ROOM_NAME = "room-app-unicast-test"
const APP_INSTANCE_ID = roomAppInstanceId(ROOM_NAME, "test-app-1")
const SECOND_TEST_APP_INSTANCE_ID = roomAppInstanceId(ROOM_NAME, "test-app-2")
const THIRD_TEST_APP_INSTANCE_ID = roomAppInstanceId(ROOM_NAME, "test-app-3")
const TEST_CATALOG_RESPONSE = {
  version: 1,
  apps: [
    {
      id: "test-app-1",
      label: "Test App 1",
      path: "/test-app-1",
      status: "active",
    },
    {
      id: "test-app-2",
      label: "Test App 2",
      path: "/test-app-2",
      status: "active",
    },
    {
      id: "test-app-3",
      label: "Test App 3",
      path: "/test-app-3",
      status: "active",
    },
  ],
}

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
      "agent-c": participant("agent-c", "agent", {
        connectionNonce: "nonce-agent-c",
      }),
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
  const catalogService = {
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify(TEST_CATALOG_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ),
  }
  const ctx = {
    storage: {
      get: async (key: string) => {
        const value = store.get(key)
        return value === undefined ? undefined : structuredClone(value)
      },
      put: async (key: string, value: unknown) =>
        void store.set(key, structuredClone(value)),
      delete: async (key: string) => void store.delete(key),
      deleteAll: async () => void store.clear(),
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
    {
      SFU_ROOM: {},
      ROOM_APPS_ENABLED: "true",
      ROOM_APP_CONTROL_PLANE: catalogService,
    } as never
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
    payload: Record<string, unknown>,
    appInstanceId = APP_INSTANCE_ID
  ) => {
    const message = JSON.stringify({
      type: "room-app-unicast",
      requestId,
      targetParticipantId,
      appInstanceId,
      payload,
    })
    return (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(socket as unknown as WebSocket, message)
  }
  const setHostReady = async (
    socket: FakeSocket,
    appInstanceId = APP_INSTANCE_ID,
    ready = true
  ) =>
    (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({
        type: "room-app-host-state",
        appInstanceId,
        ready,
      })
    )
  const requestFromAgent = (
    appInstanceId = APP_INSTANCE_ID,
    payload: Record<string, unknown> = { opaque: true }
  ) =>
    session.fetch(
      new Request("https://room/agent-app-request", {
        method: "POST",
        headers: {
          "X-Room-Participant-Id": "agent-c",
          "X-Room-Participant-Token": "token-agent-c",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ appInstanceId, payload }),
      })
    )
  const sendHostResponse = (
    socket: FakeSocket,
    response: Record<string, unknown>
  ) =>
    (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(socket as unknown as WebSocket, JSON.stringify(response))
  return {
    session,
    store,
    sockets,
    catalogService,
    addHumanSocket,
    addAgentSocket,
    sendFrom,
    setHostReady,
    requestFromAgent,
    sendHostResponse,
  }
}

describe("RoomSession reliable participant unicast (#377)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("offline", { status: 503 }))
    )
  })

  afterEach(() => {
    setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
    vi.unstubAllGlobals()
  })

  it("allowlists App unicast only for its current Room instance", async () => {
    const { addHumanSocket, sendFrom } = makeRoomSession()
    const sender = addHumanSocket("human-a")
    const target = addHumanSocket("human-b")

    await sendFrom(
      sender,
      "human-a",
      "draw_guess_request",
      "human-b",
      { type: "private_projection" },
      SECOND_TEST_APP_INSTANCE_ID
    )
    expect(target.messages()).toEqual([
      {
        type: "room-app-unicast",
        protocolVersion: 1,
        appInstanceId: SECOND_TEST_APP_INSTANCE_ID,
        sourceParticipantId: "human-a",
        payload: { type: "private_projection" },
      },
    ])

    await sendFrom(
      sender,
      "human-a",
      "draw_guess_wrong_room",
      "human-b",
      { type: "private_projection" },
      roomAppInstanceId("another-room", "test-app-2")
    )
    expect(target.messages()).toHaveLength(1)
    expect(sender.messages().at(-1)).toMatchObject({
      requestId: "draw_guess_wrong_room",
      ok: false,
      error: "app_unavailable",
    })
  })

  it("routes one opaque Agent request to the unique active host and correlates its result", async () => {
    const {
      store,
      addHumanSocket,
      addAgentSocket,
      setHostReady,
      requestFromAgent,
      sendHostResponse,
    } = makeRoomSession()
    const host = addHumanSocket("human-a")
    const other = addHumanSocket("human-b")
    addAgentSocket("agent-c")
    await setHostReady(host)
    const pending = requestFromAgent(APP_INSTANCE_ID, {
      arbitrary: { value: 42 },
    })
    await vi.waitFor(() => expect(host.messages()).toHaveLength(1))
    const request = host.messages()[0]!
    expect(request).toMatchObject({
      type: "room-app-agent-request",
      appInstanceId: APP_INSTANCE_ID,
      payload: { arbitrary: { value: 42 } },
    })
    expect(other.messages()).toEqual([])
    const responseMessage = {
      type: "room-app-agent-response",
      requestId: request.requestId,
      appInstanceId: APP_INSTANCE_ID,
      ok: true,
      result: { arbitrary: ["result"] },
    }
    await sendHostResponse(host, responseMessage)
    const result = await pending
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      ok: true,
      result: { arbitrary: ["result"] },
    })
    expect(
      (store.get("room") as ReturnType<typeof buildStoredRoom>).messages
    ).toEqual([])
    expect(JSON.stringify([...store.values()])).not.toContain('"value":42')
    // A replayed/late response no longer has a live correlation and is ignored.
    await sendHostResponse(host, responseMessage)
    expect(host.sent).toHaveLength(1)
  })

  it("projects only current curated Room Apps into the resident Agent view", async () => {
    const { session, store, addHumanSocket, setHostReady } = makeRoomSession()
    const host = addHumanSocket("human-a")
    await setHostReady(host, APP_INSTANCE_ID)
    await setHostReady(host, SECOND_TEST_APP_INSTANCE_ID)
    const room = store.get("room") as ReturnType<typeof buildStoredRoom>
    const result = (
      session as unknown as {
        agentEvents: (
          room: ReturnType<typeof buildStoredRoom>,
          participantId: string,
          cursor: number
        ) => {
          roomApps: unknown[]
        }
      }
    ).agentEvents(room, "agent-c", 0)
    expect(result.roomApps).toEqual([
      {
        appInstanceId: APP_INSTANCE_ID,
        appId: "test-app-1",
        title: "Test App 1",
        source: "curated",
        callable: true,
      },
      {
        appInstanceId: SECOND_TEST_APP_INSTANCE_ID,
        appId: "test-app-2",
        title: "Test App 2",
        source: "curated",
        callable: true,
      },
    ])
    expect(JSON.stringify(result.roomApps)).not.toMatch(
      /url|token|bearer|socket/i
    )
  })

  it("commits ready discovery before accepting the next addressed Human chat", async () => {
    const { session, store, catalogService, addHumanSocket, setHostReady } =
      makeRoomSession()
    let resolveCatalog!: (response: Response) => void
    const catalogResponse = new Promise<Response>((resolve) => {
      resolveCatalog = resolve
    })
    catalogService.fetch.mockImplementationOnce(() => catalogResponse)
    const host = addHumanSocket("human-a")

    const ready = setHostReady(host, APP_INSTANCE_ID)
    await vi.waitFor(() => expect(catalogService.fetch).toHaveBeenCalledOnce())

    const sendChat = (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(
      host as unknown as WebSocket,
      JSON.stringify({
        type: "chat",
        text: "Draw this on the board",
        targets: ["agent-c"],
      })
    )
    await Promise.resolve()
    expect(
      (store.get("room") as ReturnType<typeof buildStoredRoom>).messages
    ).toHaveLength(0)

    resolveCatalog(
      new Response(JSON.stringify(TEST_CATALOG_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    await Promise.all([ready, sendChat])

    const room = store.get("room") as ReturnType<typeof buildStoredRoom>
    expect(room.messages).toHaveLength(1)
    expect(room.messages[0]).toMatchObject({
      type: "text",
      text: "Draw this on the board",
      targets: ["agent-c"],
    })
    const projection = (
      session as unknown as {
        agentEvents: (
          room: ReturnType<typeof buildStoredRoom>,
          participantId: string,
          cursor: number
        ) => {
          events: Array<{ text?: string; addressed: boolean }>
          roomApps: unknown[]
        }
      }
    ).agentEvents(room, "agent-c", 0)
    expect(projection.events).toContainEqual(
      expect.objectContaining({
        text: "Draw this on the board",
        addressed: true,
      })
    )
    expect(projection.roomApps).toContainEqual({
      appInstanceId: APP_INSTANCE_ID,
      appId: "test-app-1",
      title: "Test App 1",
      source: "curated",
      callable: true,
    })
  })

  it("does not block ordinary Human chat on pending Room App readiness", async () => {
    const { session, store, catalogService, addHumanSocket, setHostReady } =
      makeRoomSession()
    let resolveCatalog!: (response: Response) => void
    const catalogResponse = new Promise<Response>((resolve) => {
      resolveCatalog = resolve
    })
    catalogService.fetch.mockImplementationOnce(() => catalogResponse)
    const host = addHumanSocket("human-a")

    const ready = setHostReady(host, APP_INSTANCE_ID)
    await vi.waitFor(() => expect(catalogService.fetch).toHaveBeenCalledOnce())
    const ordinaryChat = (
      session as unknown as {
        webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
      }
    ).webSocketMessage(
      host as unknown as WebSocket,
      JSON.stringify({ type: "chat", text: "Ordinary room chat" })
    )

    await vi.waitFor(() => {
      expect(
        (store.get("room") as ReturnType<typeof buildStoredRoom>).messages
      ).toHaveLength(1)
    })
    expect(
      (store.get("room") as ReturnType<typeof buildStoredRoom>).messages[0]
    ).toMatchObject({ text: "Ordinary room chat" })

    resolveCatalog(
      new Response(JSON.stringify(TEST_CATALOG_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    await Promise.all([ready, ordinaryChat])
  })

  it("refreshes catalog truth before accepting an addressed Agent chat", async () => {
    vi.useFakeTimers()
    try {
      const { session, store, catalogService, addHumanSocket, setHostReady } =
        makeRoomSession()
      const host = addHumanSocket("human-a")
      await setHostReady(host, APP_INSTANCE_ID)
      expect(catalogService.fetch).toHaveBeenCalledOnce()

      catalogService.fetch.mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              apps: [
                {
                  id: "test-app-1",
                  label: "Test App 1",
                  path: "/test-app-1",
                  status: "disabled",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
      await vi.advanceTimersByTimeAsync(ROOM_APP_CATALOG_REFRESH_INTERVAL_MS)

      await (
        session as unknown as {
          webSocketMessage: (socket: WebSocket, raw: string) => Promise<void>
        }
      ).webSocketMessage(
        host as unknown as WebSocket,
        JSON.stringify({
          type: "chat",
          text: "Use the current App",
          targets: ["agent-c"],
        })
      )
      expect(catalogService.fetch).toHaveBeenCalledTimes(2)

      const room = store.get("room") as ReturnType<typeof buildStoredRoom>
      expect(room.messages).toHaveLength(1)
      const projection = (
        session as unknown as {
          agentEvents: (
            room: ReturnType<typeof buildStoredRoom>,
            participantId: string,
            cursor: number
          ) => { roomApps: unknown[] }
        }
      ).agentEvents(room, "agent-c", 0)
      expect(projection.roomApps).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails immediately without one active curated host", async () => {
    const { addAgentSocket, requestFromAgent } = makeRoomSession()
    addAgentSocket("agent-c")
    const response = await requestFromAgent()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "host_unavailable",
    })
    const outsideApp = await requestFromAgent(
      roomAppInstanceId("other-room", "test-app-1")
    )
    expect(outsideApp.status).toBe(404)
  })

  it("fails explicitly when more than one eligible host is active", async () => {
    const { addHumanSocket, addAgentSocket, setHostReady, requestFromAgent } =
      makeRoomSession()
    const first = addHumanSocket("human-a")
    const second = addHumanSocket("human-b")
    addAgentSocket("agent-c")
    await setHostReady(first)
    await setHostReady(second)
    const response = await requestFromAgent()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "ambiguous_host",
    })
    expect(first.messages()).toEqual([])
    expect(second.messages()).toEqual([])
  })

  it("ends an in-flight request immediately when its selected host disconnects", async () => {
    const {
      session,
      addHumanSocket,
      addAgentSocket,
      setHostReady,
      requestFromAgent,
    } = makeRoomSession()
    const host = addHumanSocket("human-a")
    addAgentSocket("agent-c")
    await setHostReady(host)
    const pending = requestFromAgent()
    await vi.waitFor(() => expect(host.messages()).toHaveLength(1))
    await (
      session as unknown as {
        webSocketClose: (
          socket: WebSocket,
          code: number,
          reason: string,
          clean: boolean
        ) => Promise<void>
      }
    ).webSocketClose(host as unknown as WebSocket, 1000, "closed", true)
    const response = await pending
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "host_disconnected",
    })
  })

  it("fails only the request for an App that closes on a multi-App host", async () => {
    const {
      addHumanSocket,
      addAgentSocket,
      setHostReady,
      requestFromAgent,
      sendHostResponse,
    } = makeRoomSession()
    const host = addHumanSocket("human-a")
    addAgentSocket("agent-c")
    await setHostReady(host, APP_INSTANCE_ID)
    await setHostReady(host, SECOND_TEST_APP_INSTANCE_ID)

    const closes = requestFromAgent(APP_INSTANCE_ID)
    const remains = requestFromAgent(SECOND_TEST_APP_INSTANCE_ID)
    await vi.waitFor(() => expect(host.messages()).toHaveLength(2))
    const secondRequest = host
      .messages()
      .find((message) => message.appInstanceId === SECOND_TEST_APP_INSTANCE_ID)!
    await setHostReady(host, APP_INSTANCE_ID, false)

    const closedResponse = await closes
    expect(await closedResponse.json()).toMatchObject({
      ok: false,
      error: "host_unavailable",
    })
    await sendHostResponse(host, {
      type: "room-app-agent-response",
      requestId: secondRequest.requestId,
      appInstanceId: SECOND_TEST_APP_INSTANCE_ID,
      ok: true,
      result: { opaque: true },
    })
    expect(await (await remains).json()).toEqual({
      ok: true,
      result: { opaque: true },
    })
  })

  it("clears pending requests when the Room expires", async () => {
    const {
      session,
      store,
      addHumanSocket,
      addAgentSocket,
      setHostReady,
      requestFromAgent,
    } = makeRoomSession()
    const host = addHumanSocket("human-a")
    addAgentSocket("agent-c")
    await setHostReady(host)
    const pending = requestFromAgent()
    await vi.waitFor(() => expect(host.messages()).toHaveLength(1))
    const room = store.get("room") as ReturnType<typeof buildStoredRoom>
    room.expiresAt = Date.now() - 1
    store.set("room", room)
    await (session as unknown as { alarm: () => Promise<void> }).alarm()
    const response = await pending
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "room_expired",
    })
  })

  it("delivers private App payloads only to the targeted Human in the current Room", async () => {
    const { store, addHumanSocket, addAgentSocket, sendFrom } =
      makeRoomSession()
    const sender = addHumanSocket("human-a")
    const target = addHumanSocket("human-b")
    const otherHuman = addHumanSocket("human-c")
    const agent = addAgentSocket("agent-c")
    const privateVote = { type: "vote", value: "8" }

    await sendFrom(
      sender,
      "human-a",
      "private_payload_request",
      "human-b",
      privateVote,
      THIRD_TEST_APP_INSTANCE_ID
    )

    expect(target.messages()).toEqual([
      {
        type: "room-app-unicast",
        protocolVersion: 1,
        appInstanceId: THIRD_TEST_APP_INSTANCE_ID,
        sourceParticipantId: "human-a",
        payload: privateVote,
      },
    ])
    expect(sender.messages()).toEqual([
      {
        type: "room-app-unicast-result",
        requestId: "private_payload_request",
        appInstanceId: THIRD_TEST_APP_INSTANCE_ID,
        ok: true,
      },
    ])
    expect(otherHuman.messages()).toEqual([])
    expect(agent.messages()).toEqual([])
    expect(
      (store.get("room") as ReturnType<typeof buildStoredRoom>).messages
    ).toEqual([])
    expect(JSON.stringify(store.get("room"))).not.toContain('"value":"8"')

    await sendFrom(
      sender,
      "human-a",
      "wrong_room_payload_request",
      "human-b",
      privateVote,
      roomAppInstanceId("another-room", "test-app-3")
    )
    expect(target.messages()).toHaveLength(1)
    expect(sender.messages().at(-1)).toMatchObject({
      type: "room-app-unicast-result",
      requestId: "wrong_room_payload_request",
      ok: false,
      error: "app_unavailable",
    })
  })

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
    await sendFrom(validSender, "human-a", "request_self", "human-a", {
      type: "private",
    })
    expect(validSender.messages().at(-1)).toMatchObject({
      type: "room-app-unicast-result",
      requestId: "request_self",
      ok: false,
      error: "invalid_target",
    })
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

  it("loads the Lab catalog through its bound service for server-side instance validation", async () => {
    const { addHumanSocket, catalogService, sendFrom } = makeRoomSession()
    const sender = addHumanSocket("human-a")
    const target = addHumanSocket("human-b")
    catalogService.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 1,
          apps: [
            {
              id: "lab-only",
              label: "Lab Only",
              path: "/lab-only",
              status: "active",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    const labOnlyInstanceId = roomAppInstanceId(ROOM_NAME, "lab-only")

    await sendFrom(
      sender,
      "human-a",
      "lab_only_request",
      "human-b",
      { type: "private_projection" },
      labOnlyInstanceId
    )

    expect(catalogService.fetch).toHaveBeenCalledTimes(1)
    expect(catalogService.fetch).toHaveBeenCalledWith(
      ROOM_APP_CATALOG_ENDPOINT,
      expect.objectContaining({ credentials: "omit", mode: "cors" })
    )
    expect(target.messages()).toEqual([
      {
        type: "room-app-unicast",
        protocolVersion: 1,
        appInstanceId: labOnlyInstanceId,
        sourceParticipantId: "human-a",
        payload: { type: "private_projection" },
      },
    ])
  })
})
