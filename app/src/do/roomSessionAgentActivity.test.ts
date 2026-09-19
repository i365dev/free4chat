import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"

function makeRoom() {
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
      agentT: {
        id: "agentT",
        name: "Agent T",
        kind: "agent",
        connected: true,
        joinedAt: now,
        lastSeenAt: now,
        token: "agentT-token",
      },
      agentU: {
        id: "agentU",
        name: "Agent U",
        kind: "agent",
        connected: true,
        joinedAt: now,
        lastSeenAt: now,
        token: "agentU-token",
      },
    },
    messages: [
      {
        id: "request-message",
        peerId: "human",
        name: "Human",
        kind: "human",
        type: "action",
        actionType: "collab",
        sequence: 1,
        createdAt: now,
        collab: {
          requestId: "request-1",
          kind: "request",
          fromParticipantId: "human",
          targetParticipantId: "agentT",
          summary: "Task T",
        },
        targets: ["agentT"],
      },
    ],
    nextMessageSequence: 1,
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    nextLiveTranscriptEpoch: 1,
    nextTranscriptSequence: 1,
    attachments: [],
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

function harness() {
  const stored = makeRoom()
  const store = new Map<string, unknown>([["room", stored]])
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [] as WebSocket[],
  }
  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  const control = async (body: Record<string, unknown>) => {
    const response = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
    return { status: response.status, json: await response.json() }
  }
  return { session, control, store }
}

function activities(room: ReturnType<typeof harness>) {
  return [...(room.session as any).transientAgentActivities.values()] as {
    agentParticipantId: string
    scopeId: string
    state: string
    turnSequence?: number
  }[]
}

describe("RoomSession transient Agent activity", () => {
  it("authenticates task ownership, coalesces states, and never persists activity", async () => {
    const room = harness()
    const working = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "working",
      turnSequence: 42,
    })
    expect(working).toMatchObject({ status: 200, json: { changed: true } })
    const duplicate = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "working",
      turnSequence: 42,
    })
    expect(duplicate).toMatchObject({ status: 200, json: { changed: false } })
    const thinking = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "thinking",
      turnSequence: 42,
    })
    expect(thinking.status).toBe(200)
    const clear = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: null,
      turnSequence: 0,
    })
    expect(clear).toMatchObject({ status: 200, json: { changed: true } })
    expect((room.session as any).transientAgentActivities.size).toBe(0)
    expect((room.store.get("room") as any).messages).toHaveLength(1)
  })

  it("rejects another Agent's task scope and invalid authentication", async () => {
    const room = harness()
    const wrongAgent = await room.control({
      action: "agent-activity",
      participantId: "agentU",
      token: "agentU-token",
      scopeId: "task:request-1",
      activity: "working",
      turnSequence: 42,
    })
    expect(wrongAgent.status).toBe(403)
    const wrongToken = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "wrong",
      scopeId: "room",
      activity: "working",
      turnSequence: 42,
    })
    expect(wrongToken.status).toBe(401)
    const human = await room.control({
      action: "agent-activity",
      participantId: "human",
      token: "human-token",
      scopeId: "room",
      activity: "working",
      turnSequence: 42,
    })
    expect(human.status).toBe(403)
  })

  it("still rejects an explicitly malformed turn", async () => {
    const room = harness()
    // An ABSENT field is the legacy-compatible case (covered below); these are
    // explicit values that cannot identify a turn and must fail closed.
    for (const turnSequence of [0, -1, 1.5, "42", null, {}]) {
      const invalid = await room.control({
        action: "agent-activity",
        participantId: "agentT",
        token: "agentT-token",
        scopeId: "task:request-1",
        activity: "working",
        turnSequence,
      })
      expect(invalid).toMatchObject({
        status: 400,
        json: { error: "invalid_activity_turn" },
      })
    }
  })

  it("requires an exact positive turn and replaces the identity on the next turn", async () => {
    const room = harness()
    await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "working",
      turnSequence: 42,
    })
    // The same state on a new turn is a real change: the projection must carry
    // the new exact turn so a later interrupt binds to it.
    const nextTurn = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "working",
      turnSequence: 47,
    })
    expect(nextTurn).toMatchObject({ status: 200, json: { changed: true } })
    expect(activities(room)).toEqual([
      {
        agentParticipantId: "agentT",
        scopeId: "task:request-1",
        state: "working",
        turnSequence: 47,
      },
    ])
  })

  it("accepts a legacy Agent activity that carries no turnSequence", async () => {
    const room = harness()
    // Pre-#414 Agent binaries send only scopeId + activity. The projection must
    // still appear; it just carries no exact-turn identity.
    const legacy = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "thinking",
    })
    expect(legacy).toMatchObject({ status: 200, json: { changed: true } })
    expect(activities(room)).toEqual([
      {
        agentParticipantId: "agentT",
        scopeId: "task:request-1",
        state: "thinking",
      },
    ])
    expect("turnSequence" in activities(room)[0]).toBe(false)

    // A legacy replay of the same state is still unchanged.
    const replay = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "thinking",
    })
    expect(replay).toMatchObject({ status: 200, json: { changed: false } })

    // A legacy clear (null with no turn) is accepted too.
    const clear = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: null,
    })
    expect(clear).toMatchObject({ status: 200, json: { changed: true } })
    expect(activities(room)).toEqual([])
  })

  it("tracks legacy and exact-turn producers without inheriting identity", async () => {
    const room = harness()
    const publish = (activity: unknown, turnSequence?: unknown) =>
      room.control({
        action: "agent-activity",
        participantId: "agentT",
        token: "agentT-token",
        scopeId: "task:request-1",
        activity,
        ...(turnSequence === undefined ? {} : { turnSequence }),
      })

    // legacy -> exact: a real change that starts carrying exact-turn identity.
    expect(await publish("thinking")).toMatchObject({
      status: 200,
      json: { changed: true },
    })
    expect(await publish("thinking", 42)).toMatchObject({
      status: 200,
      json: { changed: true },
    })
    expect(activities(room)).toEqual([
      {
        agentParticipantId: "agentT",
        scopeId: "task:request-1",
        state: "thinking",
        turnSequence: 42,
      },
    ])

    // exact -> legacy (old producer): a real change that LOSES the identity
    // instead of inheriting 42 from the previous activity.
    expect(await publish("thinking")).toMatchObject({
      status: 200,
      json: { changed: true },
    })
    expect(activities(room)).toEqual([
      {
        agentParticipantId: "agentT",
        scopeId: "task:request-1",
        state: "thinking",
      },
    ])
    expect("turnSequence" in activities(room)[0]).toBe(false)
  })
})
