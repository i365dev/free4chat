import { afterEach, describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

type DomainState = {
  instanceId: string
  value: number
  revision: number
  currentTurnParticipantId: string | null
  participants: Record<string, { participantId: string; displayName: string }>
  tokens: Record<string, string>
}

type SessionOptions = {
  deferFirstJoin?: Promise<void>
  onFirstJoinStarted?: () => void
  failStateReadsAfterIncrement?: boolean
}

type Control = (
  body: Record<string, unknown>
) => Promise<{ response: Response; json: Record<string, unknown> }>

function humanParticipant(id: string, name: string) {
  return {
    id,
    name,
    kind: "human",
    joinedAt: Date.now(),
    token: `room-token-${id.slice(-1)}`,
    media: {
      sessionId: `session-${id.slice(-1)}`,
      muted: false,
      fileChannelReady: false,
      tracks: [],
    },
  }
}

async function registerHuman(control: Control, id = "room-b", name = "B") {
  return control({
    action: "register",
    participant: humanParticipant(id, name),
  })
}

async function startCounter(control: Control) {
  return control({
    action: "counter-start",
    participantId: "room-a",
    token: "room-token-a",
  })
}

async function joinCounterAsB(control: Control) {
  return control({
    action: "counter-join",
    participantId: "room-b",
    token: "room-token-b",
  })
}

function projection(state: DomainState, participantId: string) {
  const participant = state.participants[participantId]
  return {
    instanceId: state.instanceId,
    value: state.value,
    revision: state.revision,
    participant: {
      participantId,
      displayName: participant.displayName,
      mayAct: state.currentTurnParticipantId === participantId,
    },
    participants: Object.values(state.participants).map((entry) => ({
      participantId: entry.participantId,
      displayName: entry.displayName,
      isCurrentTurn: entry.participantId === state.currentTurnParticipantId,
    })),
    currentTurnParticipantId: state.currentTurnParticipantId,
  }
}

function makeStoredRoom() {
  return {
    createdAt: Date.now(),
    expiresAt: FAR_FUTURE,
    participants: {
      "room-a": {
        id: "room-a",
        name: "A",
        kind: "human",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "room-token-a",
        media: {
          sessionId: "session-a",
          muted: false,
          fileChannelReady: false,
          tracks: [],
        },
      },
    },
    messages: [],
    nextMessageSequence: 0,
    meetingNotes: { active: false },
    agentVoice: {},
    liveTranscript: { active: false },
    pendingMediaCleanup: [],
  }
}

function makeSession(options: SessionOptions = {}) {
  const store = new Map<string, unknown>([["room", makeStoredRoom()]])
  const domain: DomainState = {
    instanceId: "counter-instance",
    value: 0,
    revision: 0,
    currentTurnParticipantId: null,
    participants: {},
    tokens: {},
  }
  const calls: Array<{
    url: string
    init: RequestInit
  }> = []
  let joinCalls = 0
  let incrementCommitted = false
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.endsWith("/counter"))
        return Response.json({ instanceId: domain.instanceId }, { status: 201 })

      const match = url.match(/\/counter\/([^/]+)(\/.*)$/)
      if (!match) return Response.json({ code: "not_found" }, { status: 404 })
      const path = match[2]
      if (path === "/join") {
        joinCalls += 1
        if (joinCalls === 1) {
          options.onFirstJoinStarted?.()
          if (options.deferFirstJoin) await options.deferFirstJoin
        }
        const body = JSON.parse(String(init?.body)) as {
          participantId: string
          displayName: string
        }
        const accessToken = `domain-token-${body.participantId}`
        domain.tokens[body.participantId] = accessToken
        domain.participants[body.participantId] = {
          participantId: body.participantId,
          displayName: body.displayName,
        }
        domain.revision += 1
        domain.currentTurnParticipantId ??= body.participantId
        return Response.json(
          {
            accessToken,
            projection: projection(domain, body.participantId),
          },
          { status: 201 }
        )
      }
      const authorization = new Headers(init?.headers).get("Authorization")
      const participantId = Object.entries(domain.tokens).find(
        ([, token]) => authorization === `Bearer ${token}`
      )?.[0]
      if (!participantId)
        return Response.json({ code: "unauthorized" }, { status: 401 })
      if (path === "/state") {
        if (options.failStateReadsAfterIncrement && incrementCommitted)
          return Response.json({ code: "state_unavailable" }, { status: 503 })
        return Response.json(projection(domain, participantId))
      }
      if (path === "/actions/increment") {
        const body = JSON.parse(String(init?.body)) as {
          expectedRevision: number
        }
        if (domain.currentTurnParticipantId !== participantId)
          return Response.json({ code: "not_your_turn" }, { status: 403 })
        if (body.expectedRevision !== domain.revision)
          return Response.json({ code: "stale_revision" }, { status: 409 })
        domain.value += 1
        domain.revision += 1
        domain.currentTurnParticipantId =
          Object.keys(domain.participants).find((id) => id !== participantId) ??
          participantId
        incrementCommitted = true
        return Response.json({
          value: domain.value,
          revision: domain.revision,
          participantId,
          duplicate: false,
          attention: domain.currentTurnParticipantId
            ? {
                type: "your_turn",
                participantId: domain.currentTurnParticipantId,
                revision: domain.revision,
              }
            : null,
        })
      }
      return Response.json({ code: "not_found" }, { status: 404 })
    }
  )
  vi.stubGlobal("fetch", fetchImpl)

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
    id: { name: "room-counter-test", toString: () => "room-counter-test" },
  }
  const session = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      ROOM_COUNTER_EXPERIMENT: "true",
      COUNTER_BASE_URL: "https://counter.test",
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
      response,
      json: (await response.json()) as Record<string, unknown>,
    }
  }
  return { session, store, domain, calls, control }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("RoomSession Counter bridge experiment", () => {
  it("reuses Room identities, isolates capabilities, and keeps actions off Agent waiters", async () => {
    const { session, store, domain, calls, control } = makeSession()

    const started = await control({
      action: "counter-start",
      participantId: "room-a",
      token: "room-token-a",
    })
    expect(started.response.status).toBe(200)
    expect(
      (started.json.projection as { participant: { participantId: string } })
        .participant.participantId
    ).toBe("room-a")

    const startedRoom = store.get("room") as {
      counterTask: Record<string, unknown>
    }
    const startedTask = startedRoom.counterTask
    expect(startedTask.instanceId).toBe("counter-instance")
    expect(
      JSON.stringify(
        (session as any).stateFor(await (session as any).activeRoom())
      )
    ).not.toContain("domain-token")
    expect(
      JSON.stringify(
        (session as any).stateFor(await (session as any).activeRoom())
      )
    ).not.toContain("room-token")

    const joinedRoomB = await control({
      action: "register",
      participant: {
        id: "room-b",
        name: "B",
        kind: "human",
        joinedAt: Date.now(),
        token: "room-token-b",
        media: {
          sessionId: "session-b",
          muted: false,
          fileChannelReady: false,
          tracks: [],
        },
      },
    })
    expect(joinedRoomB.response.status).toBe(200)

    const joined = await control({
      action: "counter-join",
      participantId: "room-b",
      token: "room-token-b",
    })
    expect(joined.response.status).toBe(200)
    expect(
      (joined.json.projection as { participant: { participantId: string } })
        .participant.participantId
    ).toBe("room-b")
    expect(domain.participants).toEqual({
      "room-a": { participantId: "room-a", displayName: "A" },
      "room-b": { participantId: "room-b", displayName: "B" },
    })
    expect(
      calls.filter((call) => call.url.endsWith("/join")).map((call) => call.url)
    ).toEqual([
      "https://counter.test/counter/counter-instance/join",
      "https://counter.test/counter/counter-instance/join",
    ])

    const task = (
      store.get("room") as {
        counterTask: { capabilities: Record<string, { accessToken: string }> }
      }
    ).counterTask
    expect(task.capabilities["room-a"]?.accessToken).not.toBe(
      task.capabilities["room-b"]?.accessToken
    )
    expect(
      JSON.stringify(
        (session as any).stateFor(await (session as any).activeRoom())
      )
    ).not.toContain("domain-token")

    const rejected = await control({
      action: "counter-increment",
      participantId: "room-b",
      token: "room-token-b",
    })
    expect(rejected.response.status).toBe(403)
    expect(domain.value).toBe(0)

    const incrementedByA = await control({
      action: "counter-increment",
      participantId: "room-a",
      token: "room-token-a",
    })
    expect(incrementedByA.response.status).toBe(200)
    expect(domain.value).toBe(1)
    expect(domain.currentTurnParticipantId).toBe("room-b")

    const incrementedByB = await control({
      action: "counter-increment",
      participantId: "room-b",
      token: "room-token-b",
    })
    expect(incrementedByB.response.status).toBe(200)
    expect(domain.value).toBe(2)
    expect(domain.currentTurnParticipantId).toBe("room-a")

    const publicState = (session as any).stateFor(
      await (session as any).activeRoom()
    ) as {
      counterTask?: { value: number; revision: number; participants: unknown[] }
      messages: unknown[]
    }
    expect(publicState.counterTask).toMatchObject({ value: 2, revision: 4 })
    expect(publicState.counterTask?.participants).toHaveLength(2)
    expect(publicState.messages).toHaveLength(0)
    expect((session as any).agentWaiters.size).toBe(0)

    const serializedCalls = JSON.stringify(calls)
    expect(serializedCalls).not.toContain("room-token-a")
    expect(serializedCalls).not.toContain("room-token-b")
    expect(
      calls
        .filter((call) => call.url.endsWith("/actions/increment"))
        .map((call) => new Headers(call.init.headers).get("Authorization"))
    ).toEqual([
      "Bearer domain-token-room-b",
      "Bearer domain-token-room-a",
      "Bearer domain-token-room-b",
    ])
  })

  it("reloads the Room after slow Counter start I/O", async () => {
    let releaseFirstJoin!: () => void
    let signalFirstJoin!: () => void
    const firstJoinStarted = new Promise<void>((resolve) => {
      signalFirstJoin = resolve
    })
    const firstJoinGate = new Promise<void>((resolve) => {
      releaseFirstJoin = resolve
    })
    const { store, control } = makeSession({
      onFirstJoinStarted: signalFirstJoin,
      deferFirstJoin: firstJoinGate,
    })

    const startPromise = startCounter(control)
    await firstJoinStarted

    const ordinaryMutation = await registerHuman(control)
    expect(ordinaryMutation.response.status).toBe(200)
    releaseFirstJoin()

    const started = await startPromise
    expect(started.response.status).toBe(200)
    const room = store.get("room") as {
      participants: Record<string, unknown>
      counterTask?: { instanceId: string }
    }
    expect(room.participants["room-b"]).toBeDefined()
    expect(room.counterTask?.instanceId).toBe("counter-instance")
  })

  it("clears the Counter task when an attached Human explicitly leaves", async () => {
    const { store, control } = makeSession()
    expect((await startCounter(control)).response.status).toBe(200)
    expect((await registerHuman(control)).response.status).toBe(200)
    expect((await joinCounterAsB(control)).response.status).toBe(200)

    const left = await control({
      action: "leave",
      participantId: "room-b",
      token: "room-token-b",
    })
    expect(left.response.status).toBe(200)
    const room = store.get("room") as {
      participants: Record<string, unknown>
      counterTask?: unknown
      messages: unknown[]
    }
    expect(room.counterTask).toBeUndefined()
    expect(room.participants["room-a"]).toBeDefined()
    expect(room.participants["room-b"]).toBeUndefined()
    expect(room.messages).toHaveLength(0)
  })

  it("keeps Counter during reconnect grace, then clears it on Human expiry", async () => {
    const { session, store, control } = makeSession()
    expect((await startCounter(control)).response.status).toBe(200)
    expect((await registerHuman(control)).response.status).toBe(200)
    expect((await joinCounterAsB(control)).response.status).toBe(200)

    const room = store.get("room") as {
      participants: Record<string, { connected: boolean; lastSeenAt: number }>
      counterTask?: unknown
    }
    room.participants["room-b"]!.connected = false
    room.participants["room-b"]!.lastSeenAt = Date.now()
    await (session as any).alarm()
    expect(room.counterTask).toBeDefined()
    expect(room.participants["room-b"]).toBeDefined()

    room.participants["room-b"]!.lastSeenAt = Date.now() - 31_000
    await (session as any).alarm()
    const expiredRoom = store.get("room") as {
      participants: Record<string, unknown>
      counterTask?: unknown
    }
    expect(expiredRoom.counterTask).toBeUndefined()
    expect(expiredRoom.participants["room-a"]).toBeDefined()
    expect(expiredRoom.participants["room-b"]).toBeUndefined()
  })

  it("returns post-increment turn state when all projection reads fail", async () => {
    const { store, domain, control } = makeSession({
      failStateReadsAfterIncrement: true,
    })
    expect((await startCounter(control)).response.status).toBe(200)
    expect((await registerHuman(control)).response.status).toBe(200)
    expect((await joinCounterAsB(control)).response.status).toBe(200)

    const incremented = await control({
      action: "counter-increment",
      participantId: "room-a",
      token: "room-token-a",
    })
    expect(incremented.response.status).toBe(200)
    expect(incremented.json.result).toMatchObject({ value: 1, revision: 3 })
    expect(incremented.json.projection).toMatchObject({
      value: 1,
      revision: 3,
      currentTurnParticipantId: "room-b",
      participant: { participantId: "room-a", mayAct: false },
    })
    expect(
      (
        incremented.json.projection as {
          participants: Array<{
            participantId: string
            isCurrentTurn: boolean
          }>
        }
      ).participants
    ).toContainEqual({
      participantId: "room-b",
      displayName: "B",
      isCurrentTurn: true,
    })
    expect(domain.currentTurnParticipantId).toBe("room-b")
    expect((store.get("room") as any).counterTask).toMatchObject({
      value: 1,
      revision: 3,
      currentTurnParticipantId: "room-b",
    })
  })
})
