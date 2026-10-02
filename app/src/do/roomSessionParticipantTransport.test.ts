import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import { participantDirectReliableChannelName } from "../common/participantDataChannel"

const hostId = "host-capability-1"
const appInstanceId = "generated:123e4567-e89b-12d3-a456-426614174000"
const appInstanceIdB = "generated:123e4567-e89b-12d3-a456-426614174001"

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
  const readyRequest = (sessionId: string, ready: boolean) =>
    new Request("https://room/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "agent-participant-data-transport-ready",
        participantId: "resident",
        token: "resident-token",
        sessionId,
        ready,
      }),
    })

  const readySession = (room: any) => {
    const session = new RoomSession({} as never, {} as never) as any
    session.loadRoom = async () => room
    session.isExpired = () => false
    session.saveRoom = vi.fn(async () => undefined)
    session.scheduleNextAlarm = vi.fn(async () => undefined)
    session.broadcastState = vi.fn(async () => undefined)
    return session
  }

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
          humanParticipantId: "owner",
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

  it("keeps source-backed Human routes when another Human disconnects or loses App readiness", () => {
    const session = new RoomSession({} as never, {} as never) as any
    const room: any = makeRoom()
    room.participants.bob = {
      id: "bob",
      token: "bob-token",
      name: "Bob",
      kind: "human",
      connected: true,
      joinedAt: 1,
      lastSeenAt: 1,
      media: {
        sessionId: "bob-session",
        appDataChannelReady: true,
        muted: false,
        fileChannelReady: true,
        tracks: [],
      },
    }
    room.messages.push({
      id: "task-message-bob",
      peerId: "bob",
      name: "Bob",
      kind: "human",
      type: "action",
      actionType: "collab",
      createdAt: 2,
      sequence: 2,
      collab: {
        kind: "request",
        requestId: "task-bob",
        fromParticipantId: "bob",
        targetParticipantId: "resident",
        summary: "Check another device",
      },
    })
    room.generatedApps[appInstanceIdB] = {
      appInstanceId: appInstanceIdB,
      taskRequestId: "task-bob",
      title: "Bob status",
      bundleBytes: 100,
      bundleRevision: 1,
      stateRevision: 0,
      createdAt: 2,
      updatedAt: 2,
    }

    const project = () =>
      session.projectRuntimeParticipantTransportState(room, "resident")
    const bothReady = project()
    expect(
      bothReady.routes.map((route: any) => route.humanParticipantId)
    ).toEqual(["owner", "bob"])
    expect(
      bothReady.sources.map((source: any) => source.participantId)
    ).toEqual(["owner", "bob"])

    room.participants.bob.connected = false
    expect(project()).toEqual({
      routes: [expect.objectContaining({ humanParticipantId: "owner" })],
      sources: [{ participantId: "owner", sessionId: "owner-session" }],
    })

    room.participants.bob.connected = true
    room.participants.bob.media.appDataChannelReady = false
    expect(project()).toEqual({
      routes: [expect.objectContaining({ humanParticipantId: "owner" })],
      sources: [{ participantId: "owner", sessionId: "owner-session" }],
    })

    room.participants.bob.media.appDataChannelReady = true
    expect(
      project().routes.map((route: any) => route.humanParticipantId)
    ).toEqual(["owner", "bob"])
  })

  it("accepts ready=false for the current session after the last route disappears", async () => {
    const room: any = makeRoom()
    room.participants.resident.participantDataTransport = {
      sessionId: "agent-session",
      ready: true,
    }
    room.generatedApps = {}
    const session = readySession(room)

    const response = await session.fetch(readyRequest("agent-session", false))

    expect(response.status).toBe(200)
    expect(room.participants.resident.participantDataTransport.ready).toBe(
      false
    )
    expect(session.broadcastState).toHaveBeenCalledOnce()
  })

  it("accepts ready=false when the final Human source disappears", async () => {
    const room: any = makeRoom()
    room.participants.resident.participantDataTransport = {
      sessionId: "agent-session",
      ready: true,
    }
    room.participants.owner.media.appDataChannelReady = false
    const session = readySession(room)

    const response = await session.fetch(readyRequest("agent-session", false))

    expect(response.status).toBe(200)
    expect(room.participants.resident.participantDataTransport.ready).toBe(
      false
    )
  })

  it("rejects stale ready=false and ready=true when no route or source remains", async () => {
    const staleRoom: any = makeRoom()
    staleRoom.participants.resident.participantDataTransport = {
      sessionId: "new-session",
      ready: true,
    }
    const staleSession = readySession(staleRoom)
    const staleResponse = await staleSession.fetch(
      readyRequest("old-session", false)
    )
    expect(staleResponse.status).toBe(401)
    expect(staleRoom.participants.resident.participantDataTransport).toEqual({
      sessionId: "new-session",
      ready: true,
    })

    const unavailableRoom: any = makeRoom()
    unavailableRoom.participants.resident.participantDataTransport = {
      sessionId: "agent-session",
      ready: false,
    }
    unavailableRoom.generatedApps = {}
    const unavailableSession = readySession(unavailableRoom)
    const readyResponse = await unavailableSession.fetch(
      readyRequest("agent-session", true)
    )
    expect(readyResponse.status).toBe(403)
    expect(
      unavailableRoom.participants.resident.participantDataTransport.ready
    ).toBe(false)
  })

  it("keeps Human SFU session IDs on the private resident envelope only", async () => {
    const room: any = makeRoom()
    room.expiresAt = Date.now() + 60_000
    room.nextMessageSequence = 1
    room.attachments = []
    room.meetingNotes = { active: false }
    room.agentVoice = {}
    room.liveTranscript = { active: false }
    room.participants.resident.connectionNonce = "resident-nonce"
    const session = readySession(room)
    const publicResponse = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "agent-wait",
          participantId: "resident",
          token: "resident-token",
          cursor: 2,
          timeoutSeconds: 0,
        }),
      })
    )
    const publicBody = await publicResponse.json()
    expect(publicBody).not.toHaveProperty("participantTransport")
    expect(JSON.stringify(publicBody)).not.toContain("owner-session")

    const send = vi.fn()
    const socket = {
      deserializeAttachment: () => ({
        kind: "agent-event",
        participantId: "resident",
        connectionNonce: "resident-nonce",
        cursor: 0,
      }),
      serializeAttachment: vi.fn(),
      close: vi.fn(),
      send,
    } as unknown as WebSocket
    session.pushAgentEventSocket(room, socket, true)

    expect(send).toHaveBeenCalledOnce()
    const privateEnvelope = JSON.parse(send.mock.calls[0][0])
    expect(privateEnvelope.participantTransport.sources).toEqual([
      { participantId: "owner", sessionId: "owner-session" },
    ])
  })

  it("authorizes only the authenticated Human in the current Task/App Agent pair", async () => {
    const session = new RoomSession({} as never, {} as never) as any
    const room: any = makeRoom()
    room.participants.bob = {
      id: "bob",
      token: "bob-token",
      name: "Bob",
      kind: "human",
      connected: true,
      joinedAt: 1,
      lastSeenAt: 1,
      media: {
        sessionId: "bob-session",
        appDataChannelReady: true,
        muted: false,
        fileChannelReady: true,
        tracks: [],
      },
    }
    room.participants.resident.participantDataTransport = {
      sessionId: "agent-direct-session",
      ready: true,
    }
    session.loadRoom = async () => room
    session.isExpired = () => false

    const request = (overrides: Record<string, unknown> = {}) =>
      new Request("https://room/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "authorize-participant-direct-datachannel",
          participantId: "owner",
          token: "owner-token",
          sessionId: "owner-session",
          peerParticipantId: "resident",
          peerSessionId: "agent-direct-session",
          dataChannelName: participantDirectReliableChannelName(
            "resident",
            "owner"
          ),
          direction: "subscribe",
          ...overrides,
        }),
      })

    const allowed = await session.fetch(request())
    expect(allowed.status).toBe(200)

    // Bob supplies the victim's exact pair label and publisher session. Core
    // still denies him because it authenticates Bob and checks the Task/App
    // association, rather than trusting the channel label.
    const denied = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "authorize-participant-direct-datachannel",
          participantId: "bob",
          token: "bob-token",
          sessionId: "bob-session",
          peerParticipantId: "resident",
          peerSessionId: "agent-direct-session",
          dataChannelName: participantDirectReliableChannelName(
            "resident",
            "owner"
          ),
          direction: "subscribe",
        }),
      })
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      error: "participant_direct_pair_not_authorized",
    })

    const agentPublish = await session.fetch(
      request({
        participantId: "resident",
        token: "resident-token",
        sessionId: "agent-direct-session",
        peerParticipantId: "owner",
        peerSessionId: undefined,
        dataChannelName: participantDirectReliableChannelName(
          "resident",
          "owner"
        ),
        direction: "publish",
      })
    )
    expect(agentPublish.status).toBe(200)
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
    // The Go Runtime serializes an empty capabilities slice with omitempty,
    // so the Room projection receives this property as absent on Adapter
    // removal.
    expect(
      Reflect.deleteProperty(room.runtimeHosts[hostId], "capabilities")
    ).toBe(true)
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
