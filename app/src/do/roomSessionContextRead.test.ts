import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"

const FUTURE = Date.now() + 60_000

function fixture() {
  const store = new Map<string, unknown>([
    [
      "room",
      {
        createdAt: Date.now(),
        expiresAt: FUTURE,
        participants: {
          "agent-a": {
            id: "agent-a",
            name: "Agent A",
            kind: "agent",
            connected: true,
            joinedAt: 1,
            lastSeenAt: Date.now(),
            token: "token-a",
          },
          "agent-b": {
            id: "agent-b",
            name: "Agent B",
            kind: "agent",
            connected: true,
            joinedAt: 1,
            lastSeenAt: Date.now(),
            token: "token-b",
          },
        },
        messages: [
          {
            id: "message-1",
            peerId: "agent-a",
            name: "Agent A",
            kind: "agent",
            type: "text",
            text: "first shared message",
            createdAt: 1,
            sequence: 1,
          },
          {
            id: "collab-2",
            peerId: "agent-b",
            name: "Agent B",
            kind: "agent",
            type: "action",
            actionType: "collab",
            collab: {
              requestId: "request-2",
              kind: "completed",
              fromParticipantId: "agent-b",
              targetParticipantId: "agent-a",
              summary: "finished review",
            },
            targets: ["agent-a"],
            createdAt: 2,
            sequence: 2,
          },
          {
            id: "message-3",
            peerId: "agent-b",
            name: "Agent B",
            kind: "agent",
            type: "text",
            text: "third shared message",
            createdAt: 3,
            sequence: 3,
          },
        ],
        attachments: [],
        nextMessageSequence: 3,
        meetingNotes: { active: false },
        agentVoice: {},
        pendingMediaCleanup: [],
      },
    ],
    [
      "live-transcript",
      {
        liveTranscript: { active: false },
        liveTranscriptSegments: [
          {
            segmentId: "segment-7",
            epoch: 1,
            sequence: 7,
            participantId: "agent-a",
            speaker: "Agent A",
            text: "first shared speech",
            createdAt: 7,
          },
          {
            segmentId: "segment-8",
            epoch: 1,
            sequence: 8,
            participantId: "agent-b",
            speaker: "Agent B",
            text: "second shared speech",
            createdAt: 8,
          },
        ],
        nextLiveTranscriptEpoch: 2,
        nextTranscriptSequence: 9,
      },
    ],
  ])
  const session = new RoomSession(
    {
      id: { toString: () => "context-room" },
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async () => undefined,
        setAlarm: async () => undefined,
        deleteAlarm: async () => undefined,
        getAlarm: async () => undefined,
      },
      getWebSockets: () => [] as WebSocket[],
    } as never,
    { SFU_ROOM: {} } as never
  )
  const control = async (body: Record<string, unknown>) => {
    const response = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
    return { status: response.status, json: await response.json() }
  }
  const read = (body: Record<string, unknown> = {}) =>
    control({
      action: "agent-read-context",
      participantId: "agent-a",
      token: "token-a",
      ...body,
    })
  return { read, store }
}

describe("RoomSession bounded historical context read (#223)", () => {
  it("is authenticated, paginated, sanitized, and keeps transcript cursors separate", async () => {
    const room = fixture()
    const first = (await room.read({ limit: 2 })) as {
      status: number
      json: Record<string, any>
    }
    expect(first.status).toBe(200)
    expect(
      first.json.events.map((event: { sequence: number }) => event.sequence)
    ).toEqual([1, 2])
    expect(first.json.events[1].collab).toMatchObject({
      requestId: "request-2",
      kind: "completed",
      summary: "finished review",
    })
    expect(first.json.hasMoreAfter).toBe(true)
    expect(
      first.json.liveTranscript.segments.map(
        (segment: { sequence: number }) => segment.sequence
      )
    ).toEqual([7, 8])
    expect(JSON.stringify(first.json)).not.toContain("token-a")
    expect(JSON.stringify(first.json)).not.toContain("connectionNonce")

    const forward = (await room.read({ afterSequence: 2, limit: 2 })) as {
      status: number
      json: Record<string, any>
    }
    expect(
      forward.json.events.map((event: { sequence: number }) => event.sequence)
    ).toEqual([3])
    expect(forward.json.hasMoreBefore).toBe(true)

    const backward = (await room.read({ beforeSequence: 3, limit: 2 })) as {
      status: number
      json: Record<string, any>
    }
    expect(
      backward.json.events.map((event: { sequence: number }) => event.sequence)
    ).toEqual([1, 2])

    const transcriptPage = (await room.read({
      afterTranscriptSequence: 7,
      transcriptLimit: 1,
    })) as { status: number; json: Record<string, any> }
    expect(
      transcriptPage.json.events.map(
        (event: { sequence: number }) => event.sequence
      )
    ).toEqual([1, 2, 3])
    expect(
      transcriptPage.json.liveTranscript.segments.map(
        (segment: { sequence: number }) => segment.sequence
      )
    ).toEqual([8])

    const retainedRoom = room.store.get("room") as {
      messages: Array<{ sequence: number }>
    }
    retainedRoom.messages = retainedRoom.messages.filter(
      (message) => message.sequence > 1
    )
    const beforeRead = JSON.stringify(retainedRoom)
    const truncated = (await room.read({ afterSequence: 0 })) as {
      status: number
      json: Record<string, any>
    }
    expect(truncated.json.truncated).toBe(true)
    expect(
      truncated.json.events.map((event: { sequence: number }) => event.sequence)
    ).toEqual([2, 3])
    expect(JSON.stringify(room.store.get("room"))).toBe(beforeRead)

    expect((await room.read({ token: "wrong" })).status).toBe(401)
    expect((await room.read({ limit: 51 })).status).toBe(400)
  })

  it("reports truncation for an intervening message gap despite an old retained attachment", async () => {
    const room = fixture()
    const retainedRoom = room.store.get("room") as {
      messages: Array<Record<string, unknown>>
      attachments: Array<Record<string, unknown>>
      nextMessageSequence: number
    }
    // This is the shape produced when the 100-message ring has advanced to
    // 101..200 while an early attachment remains in its independent 8-item
    // ring. The first merged entry is sequence 1, but 2..100 are gone.
    retainedRoom.messages = Array.from({ length: 100 }, (_, index) => {
      const sequence = index + 101
      return {
        id: `message-${sequence}`,
        peerId: "agent-b",
        name: "Agent B",
        kind: "agent",
        type: "text",
        text: `message-${sequence}`,
        createdAt: sequence,
        sequence,
      }
    })
    retainedRoom.attachments = [
      {
        id: "attachment-1",
        senderId: "agent-b",
        senderName: "Agent B",
        senderKind: "agent",
        mimeType: "text/plain",
        fileName: "early.txt",
        size: 5,
        chunkCount: 1,
        createdAt: 1,
        sequence: 1,
      },
    ]
    retainedRoom.nextMessageSequence = 200

    const page = (await room.read({ afterSequence: 1, limit: 50 })) as {
      status: number
      json: Record<string, any>
    }
    expect(page.status).toBe(200)
    expect(page.json.oldestSequence).toBe(1)
    expect(page.json.truncated).toBe(true)
    expect(
      page.json.events.map((event: { sequence: number }) => event.sequence)
    ).toEqual(Array.from({ length: 50 }, (_, index) => index + 101))
  })
})
