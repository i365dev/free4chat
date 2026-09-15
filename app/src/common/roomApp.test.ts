import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  EMPTY_ROOM_APP_CATALOG,
  ROOM_APP_CATALOG_ENDPOINT,
  ROOM_APP_CATALOG_MAX_ENTRIES,
  ROOM_APP_CATALOG_MAX_BYTES,
  ROOM_APP_CATALOG_TIMEOUT_MS,
  ROOM_APP_TRUSTED_ORIGIN,
  ROOM_APP_MAX_PAYLOAD_BYTES,
  buildRoomInviteUrl,
  createRoomAppCatalogLoader,
  decodeRoomAppClientMessage,
  decodeRoomAppEnvelope,
  decodeRoomAppUnicastEnvelope,
  decodeRoomAppUnicastResult,
  encodeRoomAppUnicastRequest,
  encodeRoomAppEnvelope,
  isRoomAppInstanceForRoom,
  isRoomAppAllowlisted,
  projectRoomAppParticipants,
  roomAppRateGuard,
  roomAppUnicastRateGuard,
  roomAppInstanceId,
  parseRoomAppCatalog,
  resolveProductionRoomAppId,
  setProductionRoomAppCatalog,
  validateRoomAppDefinition,
} from "./roomApp"

const TEST_ROOM_APP_CATALOG = [
  {
    id: "test-app",
    label: "Test App",
    url: `${ROOM_APP_TRUSTED_ORIGIN}/test-app`,
    origin: ROOM_APP_TRUSTED_ORIGIN,
  },
  {
    id: "second-app",
    label: "Second App",
    url: `${ROOM_APP_TRUSTED_ORIGIN}/second-app`,
    origin: ROOM_APP_TRUSTED_ORIGIN,
  },
]

describe("Room App host contract", () => {
  beforeEach(() => setProductionRoomAppCatalog(TEST_ROOM_APP_CATALOG))
  afterEach(() => setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG))

  it("starts with no baked-in production catalog", () => {
    expect(EMPTY_ROOM_APP_CATALOG).toEqual([])
    setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
    expect(resolveProductionRoomAppId("test-app")).toBeNull()
  })

  it("accepts only a strict, bounded Lab runtime catalog", () => {
    const valid = {
      version: 1,
      apps: [
        { id: "my-app", label: "My App", path: "/my-app", status: "active" },
        {
          id: "paused-app",
          label: "Paused",
          path: "/paused-app",
          status: "disabled",
        },
      ],
    }
    expect(parseRoomAppCatalog(valid)).toEqual([
      {
        id: "my-app",
        label: "My App",
        url: `${ROOM_APP_TRUSTED_ORIGIN}/my-app`,
        origin: ROOM_APP_TRUSTED_ORIGIN,
      },
    ])
    expect(parseRoomAppCatalog({ ...valid, version: 2 })).toBeNull()
    expect(
      parseRoomAppCatalog({
        version: 1,
        apps: [valid.apps[0], valid.apps[0]],
      })
    ).toBeNull()
    expect(
      parseRoomAppCatalog({
        version: 1,
        apps: [{ ...valid.apps[0], id: "Bad Id" }],
      })
    ).toBeNull()
    for (const path of [
      "https://evil.example/app",
      "//evil.example/app",
      "/../other",
      "/my-app/../other",
    ]) {
      expect(
        parseRoomAppCatalog({
          version: 1,
          apps: [{ ...valid.apps[0], path }],
        })
      ).toBeNull()
    }
    expect(
      parseRoomAppCatalog({
        version: 1,
        apps: [{ ...valid.apps[0], properties: { arbitrary: "data" } }],
      })
    ).toBeNull()
    expect(
      parseRoomAppCatalog({
        version: 1,
        apps: Array.from(
          { length: ROOM_APP_CATALOG_MAX_ENTRIES + 1 },
          (_, index) => ({
            id: `app-${index}`,
            label: `App ${index}`,
            path: `/app-${index}`,
            status: "active",
          })
        ),
      })
    ).toBeNull()
    expect(ROOM_APP_CATALOG_MAX_BYTES).toBe(16 * 1024)
  })

  it("treats valid remote catalogs as authoritative and never revives removed Apps", () => {
    const previous = [...TEST_ROOM_APP_CATALOG]
    try {
      const remote = parseRoomAppCatalog({
        version: 1,
        apps: [
          {
            id: "current-app",
            label: "Current",
            path: "/current-app",
            status: "active",
          },
        ],
      })
      expect(remote).not.toBeNull()
      setProductionRoomAppCatalog(remote!)
      expect(resolveProductionRoomAppId("current-app")).toBe("current-app")
      expect(resolveProductionRoomAppId("test-app")).toBeNull()
      expect(
        isRoomAppInstanceForRoom("r", roomAppInstanceId("r", "test-app"))
      ).toBe(false)
      expect(
        isRoomAppInstanceForRoom("r", roomAppInstanceId("r", "current-app"))
      ).toBe(true)
    } finally {
      setProductionRoomAppCatalog(previous)
    }
  })

  it("fails closed when the Lab endpoint is unavailable or malformed before any valid catalog", async () => {
    const failingLoader = createRoomAppCatalogLoader(
      vi.fn(async () => new Response("offline", { status: 503 }))
    )
    await expect(failingLoader()).resolves.toEqual(EMPTY_ROOM_APP_CATALOG)

    const malformedLoader = createRoomAppCatalogLoader(
      vi.fn(async () => new Response("{not-json", { status: 200 }))
    )
    await expect(malformedLoader()).resolves.toEqual(EMPTY_ROOM_APP_CATALOG)
  })

  it("loads and accepts a valid catalog when AbortSignal.timeout is unavailable", async () => {
    const originalTimeout = Object.getOwnPropertyDescriptor(
      AbortSignal,
      "timeout"
    )
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    })
    try {
      const fetchCatalog = vi.fn(
        async (
          _input: RequestInfo | URL,
          _init?: RequestInit
        ): Promise<Response> =>
          new Response(
            JSON.stringify({
              version: 1,
              apps: [
                {
                  id: "current-app",
                  label: "Current",
                  path: "/current-app",
                  status: "active",
                },
              ],
            }),
            { status: 200 }
          )
      )
      const loader = createRoomAppCatalogLoader(fetchCatalog as typeof fetch)

      await expect(loader()).resolves.toEqual([
        {
          id: "current-app",
          label: "Current",
          url: `${ROOM_APP_TRUSTED_ORIGIN}/current-app`,
          origin: ROOM_APP_TRUSTED_ORIGIN,
        },
      ])
      expect(fetchCatalog).toHaveBeenCalledTimes(1)
      expect(fetchCatalog.mock.calls[0][0]).toBe(ROOM_APP_CATALOG_ENDPOINT)
    } finally {
      if (originalTimeout) {
        Object.defineProperty(AbortSignal, "timeout", originalTimeout)
      }
    }
  })

  it("aborts a hung catalog request after the bounded local timeout", async () => {
    vi.useFakeTimers()
    try {
      const captured: { signal?: AbortSignal } = {}
      const fetchCatalog = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            captured.signal = init?.signal ?? undefined
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"))
            })
          })
      )
      const loader = createRoomAppCatalogLoader(fetchCatalog as typeof fetch)
      const pending = loader()

      await vi.advanceTimersByTimeAsync(ROOM_APP_CATALOG_TIMEOUT_MS - 1)
      expect(captured.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(captured.signal?.aborted).toBe(true)
      await expect(pending).resolves.toEqual(EMPTY_ROOM_APP_CATALOG)
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the bounded timeout once a catalog request settles", async () => {
    vi.useFakeTimers()
    try {
      const captured: { signal?: AbortSignal } = {}
      const fetchCatalog = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          captured.signal = init?.signal ?? undefined
          return new Response(JSON.stringify({ version: 1, apps: [] }), {
            status: 200,
          })
        }
      )
      const loader = createRoomAppCatalogLoader(fetchCatalog as typeof fetch)

      await expect(loader()).resolves.toEqual([])
      expect(captured.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(ROOM_APP_CATALOG_TIMEOUT_MS * 2)
      expect(captured.signal?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the bounded timeout on failure paths as well", async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const thrown = createRoomAppCatalogLoader(
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.signal) signals.push(init.signal)
          throw new TypeError("Failed to fetch")
        }) as typeof fetch
      )
      await expect(thrown()).resolves.toEqual(EMPTY_ROOM_APP_CATALOG)

      const invalid = createRoomAppCatalogLoader(
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.signal) signals.push(init.signal)
          return new Response("{not-json", { status: 200 })
        }) as typeof fetch
      )
      await expect(invalid()).resolves.toEqual(EMPTY_ROOM_APP_CATALOG)

      await vi.advanceTimersByTimeAsync(ROOM_APP_CATALOG_TIMEOUT_MS * 2)
      for (const signal of signals) {
        expect(signal.aborted).toBe(false)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels catalog streams that exceed the byte limit before buffering them", async () => {
    const canceled = vi.fn()
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ROOM_APP_CATALOG_MAX_BYTES + 1))
      },
      cancel: canceled,
    })
    const loader = createRoomAppCatalogLoader(
      vi.fn(async () => new Response(oversizedBody))
    )

    await expect(loader()).resolves.toEqual(EMPTY_ROOM_APP_CATALOG)
    expect(canceled).toHaveBeenCalledTimes(1)
  })

  it("keeps the last accepted Lab catalog after later fetch failures", async () => {
    let now = 0
    let callCount = 0
    const fetchCatalog = vi.fn(async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            version: 1,
            apps: [
              {
                id: "current-app",
                label: "Current",
                path: "/current-app",
                status: "active",
              },
            ],
          }),
          { status: 200 }
        )
      }
      return new Response("offline", { status: 503 })
    })
    const loader = createRoomAppCatalogLoader(fetchCatalog, 10, () => now)

    await expect(loader()).resolves.toEqual([
      {
        id: "current-app",
        label: "Current",
        url: `${ROOM_APP_TRUSTED_ORIGIN}/current-app`,
        origin: ROOM_APP_TRUSTED_ORIGIN,
      },
    ])
    now = 11
    await expect(loader()).resolves.toEqual([
      {
        id: "current-app",
        label: "Current",
        url: `${ROOM_APP_TRUSTED_ORIGIN}/current-app`,
        origin: ROOM_APP_TRUSTED_ORIGIN,
      },
    ])
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
  })

  it("uses one bounded fetch for concurrent catalog consumers", async () => {
    let now = 100
    const fetchCatalog = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: 1, apps: [] }), { status: 200 })
    )
    const loader = createRoomAppCatalogLoader(fetchCatalog, 10, () => now)
    const [first, second] = await Promise.all([loader(), loader()])
    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    await loader()
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    now += 11
    await loader()
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
  })

  it("resolves only exact IDs present in the current Lab catalog", () => {
    expect(resolveProductionRoomAppId("test-app")).toBe("test-app")
    expect(resolveProductionRoomAppId("second-app")).toBe("second-app")
    expect(resolveProductionRoomAppId("test-app ")).toBeNull()
    expect(resolveProductionRoomAppId("Test-App")).toBeNull()
    expect(resolveProductionRoomAppId("removed-app")).toBeNull()
    expect(
      resolveProductionRoomAppId("https://room-apps.free4.chat/test-app")
    ).toBeNull()
    expect(resolveProductionRoomAppId("https://example.com/app")).toBeNull()
    expect(resolveProductionRoomAppId(["test-app"])).toBeNull()
    expect(resolveProductionRoomAppId("unknown")).toBeNull()
  })

  it("builds bounded Room and Lab-App invite URLs", () => {
    expect(
      buildRoomInviteUrl({
        origin: "https://free4.chat",
        roomName: "room name",
        roomType: "audio",
        appId: "test-app",
      })
    ).toBe("https://free4.chat/room?id=room+name&app=test-app")
    expect(
      buildRoomInviteUrl({
        origin: "https://free4.chat",
        roomName: "room",
        roomType: "screenshare",
        appId: "test-app",
      })
    ).toBe("https://free4.chat/room?id=room&type=screenshare&app=test-app")
    expect(
      buildRoomInviteUrl({
        origin: "https://free4.chat",
        roomName: "room",
        roomType: "screenshare",
        appId: "second-app",
      })
    ).toBe("https://free4.chat/room?id=room&type=screenshare&app=second-app")
    expect(
      buildRoomInviteUrl({
        origin: "https://free4.chat",
        roomName: "room",
        roomType: "audio",
      })
    ).toBe("https://free4.chat/room?id=room")
    expect(
      buildRoomInviteUrl({
        origin: "https://free4.chat",
        roomName: "room",
        roomType: "audio",
        appId: "unlisted-app",
      })
    ).toBe("https://free4.chat/room?id=room")
  })

  it("accepts current Lab definitions and rejects arbitrary origins", () => {
    for (const app of TEST_ROOM_APP_CATALOG) {
      expect(validateRoomAppDefinition(app)).toBe(true)
      expect(isRoomAppAllowlisted(app)).toBe(true)
    }
    expect(
      isRoomAppAllowlisted({
        id: "user-app",
        label: "User app",
        url: "https://evil.example/app",
        origin: "https://room-apps.free4.chat",
      })
    ).toBe(false)
  })

  it("treats any currently catalogued Lab App as a first-class entry", () => {
    for (const app of TEST_ROOM_APP_CATALOG) {
      expect(validateRoomAppDefinition(app)).toBe(true)
      expect(isRoomAppAllowlisted(app)).toBe(true)
      expect(resolveProductionRoomAppId(app.id)).toBe(app.id)
      const instanceId = roomAppInstanceId("room-a", app.id)
      expect(instanceId.startsWith(`${app.id}:`)).toBe(true)
      expect(isRoomAppInstanceForRoom("room-a", instanceId)).toBe(true)
      expect(isRoomAppInstanceForRoom("room-b", instanceId)).toBe(false)
    }
  })

  it("keeps catalogued Apps launchable and invite-preserving", () => {
    const ids = TEST_ROOM_APP_CATALOG.map((app) => app.id)
    const urls = TEST_ROOM_APP_CATALOG.map((app) => app.url)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(urls).size).toBe(urls.length)
    for (const app of TEST_ROOM_APP_CATALOG) {
      expect(validateRoomAppDefinition(app)).toBe(true)
      expect(isRoomAppAllowlisted(app)).toBe(true)
      expect(resolveProductionRoomAppId(app.id)).toBe(app.id)
      expect(
        isRoomAppInstanceForRoom("room-a", roomAppInstanceId("room-a", app.id))
      ).toBe(true)
      expect(
        new URL(
          buildRoomInviteUrl({
            origin: "https://free4.chat",
            roomName: "room-a",
            roomType: "audio",
            appId: app.id,
          })
        ).searchParams.get("app")
      ).toBe(app.id)
    }
  })

  it("keeps transport envelopes bounded and UTF-8 sized", () => {
    const encoded = encodeRoomAppEnvelope({
      appInstanceId: "test-app:abc123",
      lane: "reliable",
      payload: { type: "update", points: [[1, 2]] },
    })
    expect(encoded).toBeTruthy()
    expect(decodeRoomAppEnvelope(encoded)).toMatchObject({
      lane: "reliable",
      appInstanceId: "test-app:abc123",
    })
    expect(
      encodeRoomAppEnvelope({
        appInstanceId: "test-app:abc123",
        lane: "reliable",
        payload: { text: "界".repeat(ROOM_APP_MAX_PAYLOAD_BYTES) },
      })
    ).toBeNull()
    expect(
      encodeRoomAppEnvelope({
        appInstanceId: "test-app:abc123",
        lane: "reliable",
        payload: { sourceParticipantId: "spoofed" },
      })
    ).toBeNull()
    expect(decodeRoomAppEnvelope(JSON.stringify({ type: "bogus" }))).toBeNull()
  })

  it("requires the exact current instance and handshake token", () => {
    expect(
      decodeRoomAppClientMessage(
        {
          type: "ready",
          appInstanceId: "test-app:abc123",
          handshakeToken: "nonce",
        },
        "test-app:abc123"
      )
    ).toMatchObject({ type: "ready", handshakeToken: "nonce" })
    expect(
      decodeRoomAppClientMessage(
        {
          type: "sendReliable",
          appInstanceId: "other:abc123",
          payload: { type: "update" },
        },
        "test-app:abc123"
      )
    ).toBeNull()
    expect(
      decodeRoomAppClientMessage(
        {
          type: "sendReliableTo",
          appInstanceId: "test-app:abc123",
          requestId: "guess-1",
          targetParticipantId: "human-b",
          payload: { type: "private" },
        },
        "test-app:abc123"
      )
    ).toEqual({
      type: "sendReliableTo",
      appInstanceId: "test-app:abc123",
      requestId: "guess-1",
      targetParticipantId: "human-b",
      payload: { type: "private" },
    })
    expect(
      decodeRoomAppClientMessage(
        {
          type: "sendReliableTo",
          appInstanceId: "test-app:abc123",
          requestId: "guess-1",
          targetParticipantId: "bad target",
          payload: { type: "private" },
        },
        "test-app:abc123"
      )
    ).toBeNull()
    expect(
      decodeRoomAppClientMessage(
        {
          type: "sendReliableTo",
          appInstanceId: "test-app:abc123",
          requestId: "contains spaces",
          targetParticipantId: "human-b",
          payload: { type: "private" },
        },
        "test-app:abc123"
      )
    ).toBeNull()
  })

  it("decodes only the bounded engaged milestone without App properties", () => {
    const appInstanceId = "test-app:abc123"
    expect(
      decodeRoomAppClientMessage(
        { type: "milestone", appInstanceId, milestone: "engaged" },
        appInstanceId
      )
    ).toEqual({ type: "milestone", appInstanceId, milestone: "engaged" })
    for (const message of [
      { type: "milestone", appInstanceId, milestone: "mounted" },
      {
        type: "milestone",
        appInstanceId,
        milestone: "engaged",
        payload: { text: "private" },
      },
      {
        type: "milestone",
        appInstanceId,
        milestone: "engaged",
        app: "untrusted-app",
      },
      {
        type: "milestone",
        appInstanceId: "other:abc123",
        milestone: "engaged",
      },
    ])
      expect(decodeRoomAppClientMessage(message, appInstanceId)).toBeNull()
  })

  it("bounds reliable unicast requests and accepts only current-room deliveries/results", () => {
    const appInstanceId = roomAppInstanceId("room-a", "test-app")
    const encoded = encodeRoomAppUnicastRequest({
      requestId: "request_1",
      targetParticipantId: "human-b",
      appInstanceId,
      payload: { type: "secret", word: "otter" },
    })
    expect(JSON.parse(encoded!)).toMatchObject({
      type: "room-app-unicast",
      requestId: "request_1",
      targetParticipantId: "human-b",
      appInstanceId,
      payload: { word: "otter" },
    })
    expect(
      encodeRoomAppUnicastRequest({
        requestId: "request_1",
        targetParticipantId: "human-b",
        appInstanceId,
        payload: { word: "界".repeat(ROOM_APP_MAX_PAYLOAD_BYTES) },
      })
    ).toBeNull()

    const delivery = {
      type: "room-app-unicast",
      protocolVersion: 1,
      appInstanceId,
      sourceParticipantId: "human-a",
      payload: { word: "otter" },
    }
    expect(decodeRoomAppUnicastEnvelope(delivery, "room-a")).toMatchObject({
      sourceParticipantId: "human-a",
      payload: { word: "otter" },
    })
    expect(decodeRoomAppUnicastEnvelope(delivery, "room-b")).toBeNull()
    expect(
      decodeRoomAppUnicastResult(
        {
          type: "room-app-unicast-result",
          requestId: "request_1",
          appInstanceId,
          ok: false,
          error: "target_unavailable",
        },
        "room-a"
      )
    ).toMatchObject({ ok: false, error: "target_unavailable" })
  })

  it("accepts only curated instances for the current Room", () => {
    expect(isRoomAppInstanceForRoom("room-a", "test-app:00000000")).toBe(false)
    expect(
      isRoomAppInstanceForRoom(
        "room-a",
        roomAppInstanceId("room-a", "test-app")
      )
    ).toBe(true)
    expect(
      isRoomAppInstanceForRoom(
        "room-a",
        roomAppInstanceId("room-a", "second-app")
      )
    ).toBe(true)
    expect(
      isRoomAppInstanceForRoom(
        "room-a",
        roomAppInstanceId("room-a", "second-app")
      )
    ).toBe(true)
    for (const appId of ["second-app", "second-app", "second-app"])
      expect(
        isRoomAppInstanceForRoom("room-a", roomAppInstanceId("room-a", appId))
      ).toBe(true)
    expect(
      isRoomAppInstanceForRoom(
        "room-b",
        roomAppInstanceId("room-a", "second-app")
      )
    ).toBe(false)
    expect(
      isRoomAppInstanceForRoom(
        "room-b",
        roomAppInstanceId("room-a", "second-app")
      )
    ).toBe(false)
  })

  it("bounds the participant projection and separates reliable/realtime rate", () => {
    expect(
      projectRoomAppParticipants([
        { participantId: "a", name: "Alice", kind: "human" },
        { participantId: "b", name: "Pi", kind: "agent" },
      ])
    ).toEqual([
      { participantId: "a", name: "Alice", kind: "human" },
      { participantId: "b", name: "Pi", kind: "agent" },
    ])
    const guard = roomAppRateGuard()
    for (let index = 0; index < 20; index += 1)
      expect(guard.allow("reliable", 1, 1000)).toBe(true)
    expect(guard.allow("reliable", 1, 1000)).toBe(false)
    expect(guard.allow("realtime", 1, 1000)).toBe(true)
    expect(guard.allow("reliable", 1, 2001)).toBe(true)
  })

  it("prunes stale bytes from both lanes before applying the shared budget", () => {
    const guard = roomAppRateGuard()
    expect(guard.allow("realtime", 200_000, 1000)).toBe(true)
    expect(guard.allow("reliable", 100_000, 2001)).toBe(true)
  })

  it("bounds unicast message count and bytes per sender window", () => {
    const guard = roomAppUnicastRateGuard()
    for (let index = 0; index < 10; index += 1)
      expect(guard.allow(1, 1000)).toBe(true)
    expect(guard.allow(1, 1000)).toBe(false)
    expect(guard.allow(1, 2001)).toBe(true)
    const bytesGuard = roomAppUnicastRateGuard()
    expect(bytesGuard.allow(64 * 1024, 1000)).toBe(true)
    expect(bytesGuard.allow(1, 1000)).toBe(false)
  })
})
