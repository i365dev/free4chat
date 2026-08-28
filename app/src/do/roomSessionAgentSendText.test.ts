import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #165 fixture: one Human plus N Agents so addressed persistence and the
// per-agent addressed projection can be exercised against the real DO path.
function buildStoredRoom(agentIds = ["agent-a", "agent-b", "agent-c"]) {
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
        token: "tok-h1",
      },
      ...Object.fromEntries(
        agentIds.map((id) => [
          id,
          {
            id,
            name: `Agent-${id}`,
            kind: "agent",
            connected: true,
            joinedAt: 1,
            lastSeenAt: Date.now(),
            token: `tok-${id}`,
          },
        ])
      ),
    },
    messages: [],
    nextMessageSequence: 1,
    meetingNotes: { active: false },
    voiceReply: { active: false },
    pendingMediaCleanup: [],
  }
}

function makeRoomSession(stored: ReturnType<typeof buildStoredRoom>) {
  const store = new Map<string, unknown>([["room", stored]])
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    // Human sockets only; Agent control paths broadcast through the same
    // accessor, so the fake DO context must provide it.
    getWebSockets: () => [] as WebSocket[],
  }
  const rs = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
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
  const sendText = async (
    participantId: string,
    text: string,
    targetParticipantIds?: unknown
  ) =>
    control({
      action: "agent-send-text",
      participantId,
      token: `tok-${participantId}`,
      text,
      ...(targetParticipantIds === undefined ? {} : { targetParticipantIds }),
    })
  const agentWait = async (participantId: string, cursor = 0) =>
    control({
      action: "agent-wait",
      participantId,
      token: `tok-${participantId}`,
      cursor,
      timeoutSeconds: 0,
    })
  const storedMessages = () =>
    (store.get("room") as { messages: Array<Record<string, unknown>> }).messages
  return { control, sendText, agentWait, storedMessages }
}

describe("RoomSession agent-send-text structured addressing (#165)", () => {
  it("persists zero, one, and multiple explicit Agent targets", async () => {
    const room = makeRoomSession(buildStoredRoom())

    const none = await room.sendText("agent-a", "plain reply")
    expect(none.status).toBe(200)
    expect(room.storedMessages()[0].targets).toBeUndefined()

    const one = await room.sendText("agent-a", "handoff", ["agent-b"])
    expect(one.status).toBe(200)
    expect(room.storedMessages()[1].targets).toEqual(["agent-b"])

    const many = await room.sendText("agent-a", "group handoff", [
      "agent-b",
      "agent-c",
    ])
    expect(many.status).toBe(200)
    expect(room.storedMessages()[2].targets).toEqual(["agent-b", "agent-c"])
  })

  it("deduplicates, bounds, and filters targets like the Human chat path", async () => {
    const room = makeRoomSession(
      buildStoredRoom([
        "agent-1",
        "agent-2",
        "agent-3",
        "agent-4",
        "agent-5",
        "agent-6",
        "agent-7",
        "agent-8",
        "agent-9",
        "agent-10",
      ])
    )

    await room.sendText("agent-1", "dupes", ["agent-2", "agent-2", "agent-2"])
    expect(room.storedMessages()[0].targets).toEqual(["agent-2"])

    // Ten distinct valid Agent targets collapse onto the MAX_TARGETS bound.
    await room.sendText("agent-1", "overflow", [
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-5",
      "agent-6",
      "agent-7",
      "agent-8",
      "agent-9",
      "agent-10",
    ])
    const overflow = room.storedMessages()[1].targets as string[] | undefined
    expect(overflow?.length).toBe(8)
    // Self is dropped BEFORE the bound, then the first eight valid targets
    // keep their slots.
    expect(overflow).not.toContain("agent-1")
    expect(overflow).not.toContain("agent-10")
  })

  it("drops malformed, human, unknown, and self targets deterministically", async () => {
    const room = makeRoomSession(buildStoredRoom())

    await room.sendText("agent-a", "mixed", [
      42,
      null,
      "",
      "human-1",
      "ghost-agent",
      "agent-a",
      "agent-b",
    ])
    // Only the current, non-self Agent target survives; everything else
    // degrades instead of manufacturing activation.
    expect(room.storedMessages()[0].targets).toEqual(["agent-b"])

    await room.sendText("agent-a", "self only", ["agent-a"])
    expect(room.storedMessages()[1].targets).toBeUndefined()

    await room.sendText("agent-a", "names are not ids", ["Hermes Agent"])
    expect(room.storedMessages()[2].targets).toBeUndefined()
  })

  it("projects addressed=true only to targeted Agents; others see context with addressed=false", async () => {
    const room = makeRoomSession(buildStoredRoom())
    await room.sendText("agent-a", "to b only", ["agent-b"])

    const target = await room.agentWait("agent-b", 0)
    expect(target.status).toBe(200)
    const targetEvents = target.json.events as Array<{
      sequence: number
      addressed: boolean
      text?: string
    }>
    const addressedEvent = targetEvents.find(
      (event) => event.text === "to b only"
    )
    expect(addressedEvent?.addressed).toBe(true)

    const nonTarget = await room.agentWait("agent-c", 0)
    const nonTargetEvents = nonTarget.json.events as Array<{
      addressed: boolean
      text?: string
    }>
    const contextEvent = nonTargetEvents.find(
      (event) => event.text === "to b only"
    )
    expect(contextEvent?.addressed).toBe(false)
  })

  it("replays the same addressed event without duplicating it", async () => {
    const room = makeRoomSession(buildStoredRoom())
    await room.sendText("agent-a", "once", ["agent-b"])

    const first = await room.agentWait("agent-b", 0)
    const second = await room.agentWait("agent-b", 0)
    expect(first.json.events).toEqual(second.json.events)
    expect((first.json.events as unknown[]).length).toBe(1)
    expect((second.json.events as unknown[]).length).toBe(1)
  })

  it("keeps unaddressed Agent output backward compatible", async () => {
    const room = makeRoomSession(buildStoredRoom())
    const plain = await room.sendText("agent-a", "no targets here")
    expect(plain.status).toBe(200)
    const events = (await room.agentWait("agent-b", 0)).json.events as Array<{
      text?: string
      addressed: boolean
    }>
    expect(
      events.find((event) => event.text === "no targets here")?.addressed
    ).toBe(false)
  })

  it("rejects non-agent senders and missing text", async () => {
    const room = makeRoomSession(buildStoredRoom())
    const human = await room.control({
      action: "agent-send-text",
      participantId: "human-1",
      token: "tok-h1",
      text: "spoof",
    })
    expect(human.status).toBe(403)

    const stranger = await room.control({
      action: "agent-send-text",
      participantId: "agent-a",
      token: "wrong-token",
      text: "spoof",
    })
    expect(stranger.status).toBe(401)

    const blank = await room.sendText("agent-a", "   ", ["agent-b"])
    expect(blank.status).toBe(400)
  })
})
