import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"

const hostId = "host-capability-1"
const capability = {
  capabilityId: "fixture",
  title: "Fixture",
  version: "1",
  observe: true,
  actions: [
    {
      name: "set-state",
      title: "Set state",
      input: {
        type: "object",
        properties: { value: "string" },
        required: ["value"],
      },
    },
  ],
}

function makeParticipant(
  id: string,
  kind: "human" | "agent",
  connectionNonce: string,
  runtimeHostId?: string
) {
  return {
    id,
    token: `${id}-token`,
    name: id,
    kind,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    connectionNonce,
    ...(runtimeHostId ? { runtimeHostId } : {}),
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

function createHarness() {
  const room: any = {
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    analyticsRoomId: "room-analytics-id",
    participants: {
      owner: makeParticipant("owner", "human", "owner-nonce"),
      second: makeParticipant("second", "human", "second-nonce"),
      resident: makeParticipant("resident", "agent", "resident-nonce", hostId),
    },
    runtimeHosts: {
      [hostId]: {
        runtimeHostId: hostId,
        speech: { stt: false, tts: false },
        capabilities: [capability],
      },
    },
    messages: [],
    attachments: [],
    nextMessageSequence: 0,
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
  let residentAttachment: any = {
    kind: "agent-event",
    participantId: "resident",
    connectionNonce: "resident-nonce",
    cursor: 0,
  }
  const residentSocket = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn((next) => {
      residentAttachment = next
    }),
    deserializeAttachment: vi.fn(() => residentAttachment),
  }
  const ctx = {
    storage: {
      get: vi.fn(async () => room),
      put: vi.fn(async () => undefined),
      setAlarm: vi.fn(async () => undefined),
      deleteAlarm: vi.fn(async () => undefined),
      getAlarm: vi.fn(async () => undefined),
    },
    getWebSockets: vi.fn((tag?: string) =>
      tag ? [residentSocket as unknown as WebSocket] : []
    ),
  }
  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  vi.spyOn(session as any, "activeRoom").mockImplementation(async () => room)
  vi.spyOn(session as any, "saveRoom").mockResolvedValue(undefined)
  vi.spyOn(session as any, "broadcastState").mockResolvedValue(undefined)
  vi.spyOn(session as any, "scheduleNextAlarm").mockResolvedValue(undefined)
  const requester = {
    readyState: 1,
    send: vi.fn(),
  } as unknown as WebSocket
  return {
    session: session as any,
    room,
    residentSocket,
    requester,
    getResidentAttachment: () => residentAttachment,
  }
}

describe("RoomSession deterministic Runtime capability RPC", () => {
  it("routes a Generated Task App click through its canonical Task Agent and Runtime Host", async () => {
    const { session, room, residentSocket, requester } = createHarness()
    const appInstanceId = "generated:123e4567-e89b-12d3-a456-426614174000"
    const taskRequestId = "task-origin"
    room.messages = [
      {
        id: "task-message",
        peerId: "owner",
        name: "Human",
        kind: "human",
        type: "action",
        actionType: "collab",
        collab: {
          kind: "request",
          requestId: taskRequestId,
          fromParticipantId: "owner",
          targetParticipantId: "resident",
          summary: "Read printer status",
        },
        createdAt: Date.now(),
        sequence: 1,
      },
    ]
    room.generatedApps = {
      [appInstanceId]: {
        appInstanceId,
        taskRequestId,
        title: "Printer",
        bundleBytes: 100,
        bundleRevision: 2,
        stateRevision: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }
    const attachment = {
      participantId: "owner",
      token: "owner-token",
      connectionNonce: "owner-nonce",
    }

    await session.handleClientMessage(requester, attachment, {
      type: "generated-app-capability-request",
      requestId: "generated-capability-1",
      appInstanceId,
      bundleRevision: 2,
      capabilityId: "fixture",
      operation: "observe",
      runtimeHostId: "attacker-selected-host",
    })

    expect(JSON.parse(residentSocket.send.mock.calls[0]![0])).toMatchObject({
      type: "runtime-capability-request",
      requestId: "generated-capability-1",
      runtimeHostId: hostId,
      capabilityId: "fixture",
      operation: "observe",
    })
    expect(room.messages).toHaveLength(1)

    await session.handleRuntimeCapabilityResidentResult(
      residentSocket,
      session.deserializeAgentEventAttachment(residentSocket),
      JSON.stringify({
        type: "runtime-capability-result",
        requestId: "generated-capability-1",
        runtimeHostId: hostId,
        capabilityId: "fixture",
        operation: "observe",
        ok: true,
        result: { status: "ready", accepting: true },
      })
    )
    expect(JSON.parse((requester.send as any).mock.calls[0]![0])).toMatchObject(
      {
        type: "runtime-capability-result",
        requestId: "generated-capability-1",
        ok: true,
        result: { status: "ready", accepting: true },
      }
    )
  })

  it("fails closed for a stale Generated App revision and for a changed Task Agent Host", async () => {
    const { session, room, residentSocket, requester } = createHarness()
    const appInstanceId = "generated:123e4567-e89b-12d3-a456-426614174000"
    const taskRequestId = "task-origin"
    room.messages = [
      {
        id: "task-message",
        peerId: "owner",
        name: "Human",
        kind: "human",
        type: "action",
        actionType: "collab",
        collab: {
          kind: "request",
          requestId: taskRequestId,
          fromParticipantId: "owner",
          targetParticipantId: "resident",
        },
        createdAt: Date.now(),
        sequence: 1,
      },
    ]
    room.generatedApps = {
      [appInstanceId]: {
        appInstanceId,
        taskRequestId,
        title: "Printer",
        bundleBytes: 100,
        bundleRevision: 2,
        stateRevision: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }
    const attachment = {
      participantId: "owner",
      token: "owner-token",
      connectionNonce: "owner-nonce",
    }
    const request = {
      type: "generated-app-capability-request",
      requestId: "stale-generated-capability",
      appInstanceId,
      bundleRevision: 1,
      capabilityId: "fixture",
      operation: "observe",
    }
    await session.handleClientMessage(requester, attachment, request)
    expect(residentSocket.send).not.toHaveBeenCalled()

    await session.handleClientMessage(requester, attachment, {
      ...request,
      requestId: "changed-task-host",
      bundleRevision: 2,
    })
    expect(residentSocket.send).toHaveBeenCalledTimes(1)
    room.participants.resident.runtimeHostId = "another-host"
    await session.handleRuntimeCapabilityResidentResult(
      residentSocket,
      session.deserializeAgentEventAttachment(residentSocket),
      JSON.stringify({
        type: "runtime-capability-result",
        requestId: "changed-task-host",
        runtimeHostId: hostId,
        capabilityId: "fixture",
        operation: "observe",
        ok: true,
        result: { status: "ready" },
      })
    )
    expect(
      JSON.parse((requester.send as any).mock.calls.at(-1)![0])
    ).toMatchObject({
      type: "runtime-capability-result",
      requestId: "changed-task-host",
      ok: false,
      error: "unauthorized",
    })
  })
})
