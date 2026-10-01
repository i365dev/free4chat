import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"

const hostId = "host-capability-1"
const appInstanceId = "generated:123e4567-e89b-12d3-a456-426614174000"

function makeRoom() {
  return {
    participants: {
      owner: {
        id: "owner",
        token: "owner-token",
        name: "Owner",
        kind: "human",
        connected: true,
        joinedAt: 1,
        lastSeenAt: 1,
        media: {
          sessionId: "owner-session",
          appDataChannelReady: true,
          muted: false,
          fileChannelReady: true,
          tracks: [],
        },
      },
      resident: {
        id: "resident",
        token: "resident-token",
        name: "Resident",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: 1,
        runtimeHostId: hostId,
      },
    },
    runtimeHosts: {
      [hostId]: {
        runtimeHostId: hostId,
        speech: { stt: false, tts: false },
        capabilities: [
          {
            capabilityId: "printer_status",
            title: "Printer status",
            version: "1",
            observe: true,
            actions: [],
          },
        ],
      },
    },
    messages: [
      {
        id: "task-message",
        peerId: "owner",
        name: "Owner",
        kind: "human",
        type: "action",
        actionType: "collab",
        createdAt: 1,
        sequence: 1,
        collab: {
          kind: "request",
          requestId: "task-origin",
          fromParticipantId: "owner",
          targetParticipantId: "resident",
          summary: "Check device status",
        },
      },
    ],
    generatedApps: {
      [appInstanceId]: {
        appInstanceId,
        taskRequestId: "task-origin",
        title: "Status",
        bundleBytes: 100,
        bundleRevision: 2,
        stateRevision: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  }
}

describe("RoomSession Runtime participant transport association", () => {
  it("projects only the originating Task Agent, current Host, capability IDs, and ready Human sources", () => {
    const session = new RoomSession({} as never, {} as never) as any
    const state = session.projectRuntimeParticipantTransportState(
      makeRoom(),
      "resident"
    )
    expect(state).toEqual({
      routes: [
        {
          appInstanceId,
          bundleRevision: 2,
          taskRequestId: "task-origin",
          agentParticipantId: "resident",
          runtimeHostId: hostId,
          capabilityIds: ["printer_status"],
        },
      ],
      sources: [{ participantId: "owner", sessionId: "owner-session" }],
    })
    expect(JSON.stringify(state)).not.toMatch(
      /runtime-capability-(request|result)|requestId|operation|args/
    )
  })

  it("does not accept capability operation payloads through the Human Room WebSocket", async () => {
    const session = new RoomSession({} as never, {} as never) as any
    const room = makeRoom()
    session.loadRoom = async () => room
    session.isExpired = () => false
    const saveRoom = vi.fn()
    session.saveRoom = saveRoom
    const socket = {
      deserializeAttachment: () => ({
        participantId: "owner",
        token: "owner-token",
        connectionNonce: "owner-connection",
      }),
      send: vi.fn(),
      close: vi.fn(),
      serializeAttachment: vi.fn(),
    }

    await session.webSocketMessage(
      socket,
      JSON.stringify({
        type: "generated-app-capability-request",
        requestId: "request-a",
        appInstanceId,
        bundleRevision: 2,
        capabilityId: "printer_status",
        operation: "observe",
      })
    )

    expect(saveRoom).not.toHaveBeenCalled()
    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
  })

  it("keeps a live originating App route after Task completion and closes on Adapter capability loss", () => {
    const session = new RoomSession({} as never, {} as never) as any
    const room = makeRoom()
    room.messages.push({
      id: "task-complete",
      peerId: "resident",
      name: "Resident",
      kind: "agent",
      type: "action",
      actionType: "collab",
      createdAt: 2,
      sequence: 2,
      collab: {
        kind: "completed",
        requestId: "task-origin",
        fromParticipantId: "owner",
        targetParticipantId: "resident",
        summary: "Complete",
      },
    })
    expect(
      session.projectRuntimeParticipantTransportState(room, "resident").routes
    ).toHaveLength(1)
    room.runtimeHosts[hostId].capabilities = []
    expect(
      session.projectRuntimeParticipantTransportState(room, "resident").routes
    ).toHaveLength(0)
  })

  it("does not expose the Runtime session identifier through participant info", () => {
    const session = new RoomSession({} as never, {} as never) as any
    const participant = {
      id: "resident",
      token: "secret",
      kind: "agent",
      participantDataTransport: {
        sessionId: "private-sfu-session",
        ready: true,
      },
    }
    const info = session.participantForInfo(participant)
    expect(info.participantDataTransport).toBeUndefined()
    expect(JSON.stringify(info)).not.toContain("private-sfu-session")
  })
})
