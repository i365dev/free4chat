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

describe("RoomSession transient Agent activity", () => {
  it("authenticates task ownership, coalesces states, and never persists activity", async () => {
    const room = harness()
    const working = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "working",
    })
    expect(working).toMatchObject({ status: 200, json: { changed: true } })
    const duplicate = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "working",
    })
    expect(duplicate).toMatchObject({ status: 200, json: { changed: false } })
    const thinking = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: "thinking",
    })
    expect(thinking.status).toBe(200)
    const clear = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "agentT-token",
      scopeId: "task:request-1",
      activity: null,
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
    })
    expect(wrongAgent.status).toBe(403)
    const wrongToken = await room.control({
      action: "agent-activity",
      participantId: "agentT",
      token: "wrong",
      scopeId: "room",
      activity: "working",
    })
    expect(wrongToken.status).toBe(401)
    const human = await room.control({
      action: "agent-activity",
      participantId: "human",
      token: "human-token",
      scopeId: "room",
      activity: "working",
    })
    expect(human.status).toBe(403)
  })
})
