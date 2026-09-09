import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function human(): RoomRecord["participants"][string] {
  return {
    id: "human-1",
    name: "Guest",
    kind: "human",
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: "human-token",
    media: {
      sessionId: "human-session",
      muted: false,
      fileChannelReady: true,
      tracks: [{ trackName: "mic", kind: "audio" }],
    },
  }
}

function agent(id: string) {
  return {
    id,
    name: id === "agent-a" ? "Resident Agent" : "Other Agent",
    kind: "agent" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
  }
}

function room(): RoomRecord {
  return {
    createdAt: 1,
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": human(),
      "agent-a": agent("agent-a"),
      "agent-b": agent("agent-b"),
    },
    messages: [],
    nextMessageSequence: 0,
    attachments: [],
    nextTranscriptSequence: 0,
    nextLiveTranscriptEpoch: 1,
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

function harness() {
  const store = new Map<string, unknown>([["room", room()]])
  const socket = { send: vi.fn(), close: vi.fn() } as unknown as WebSocket
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
  const sendHuman = (message: unknown) =>
    (
      session as unknown as {
        handleClientMessage: (
          socket: WebSocket,
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      socket,
      {
        participantId: "human-1",
        token: "human-token",
        connectionNonce: "human-connection",
      },
      message
    )
  return {
    session,
    socket,
    sendHuman,
    stored: () => store.get("room") as RoomRecord,
  }
}

describe("RoomSession Human task entry (#305)", () => {
  it("uses the authenticated Human, validates the chosen Agent, and projects a server requestId to task scope", async () => {
    const test = harness()

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Use TASK_T_MARKER",
    })

    const message = test.stored().messages[0]
    expect(message).toMatchObject({
      peerId: "human-1",
      targets: ["agent-a"],
      collab: {
        kind: "request",
        fromParticipantId: "human-1",
        targetParticipantId: "agent-a",
        summary: "Use TASK_T_MARKER",
      },
    })
    const requestId = message.collab?.requestId
    expect(requestId).toEqual(expect.any(String))
    expect(message.collab?.requestId).not.toBe("browser-request-id")

    const event = (
      test.session as unknown as {
        toAgentEvent: (
          message: unknown,
          participantId: string
        ) => {
          scopeId?: string
          addressed: boolean
        }
      }
    ).toAgentEvent(message, "agent-a")
    expect(event).toMatchObject({
      scopeId: `task:${requestId}`,
      addressed: true,
    })

    // The other connected Agent does not receive the task scope, and the
    // canonical Room target remains only the selected Agent.
    expect(
      (
        test.session as unknown as {
          toAgentEvent: (
            message: unknown,
            participantId: string
          ) => {
            scopeId?: string
          }
        }
      ).toAgentEvent(message, "agent-b").scopeId
    ).toBeUndefined()
    expect(message.targets).toEqual(["agent-a"])

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Use TASK_U_MARKER",
    })
    const second = test.stored().messages[1]
    expect(second.collab?.summary).toBe("Use TASK_U_MARKER")
    expect(second.collab?.requestId).not.toBe(requestId)
    expect(
      (
        test.session as unknown as {
          toAgentEvent: (
            message: unknown,
            participantId: string
          ) => {
            scopeId?: string
          }
        }
      ).toAgentEvent(second, "agent-a").scopeId
    ).toBe(`task:${second.collab?.requestId}`)
  })

  it("rejects a Human or disconnected participant as the task target", async () => {
    const test = harness()

    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "human-1",
      summary: "not an Agent",
    })
    expect(
      JSON.parse(
        (test.socket.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      )
    ).toEqual({
      type: "error",
      error: "target_not_agent",
    })
    expect(test.stored().messages).toHaveLength(0)

    test.stored().participants["agent-a"].connected = false
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "stale target",
    })
    expect(
      JSON.parse(
        (test.socket.send as ReturnType<typeof vi.fn>).mock.calls[1][0]
      )
    ).toEqual({
      type: "error",
      error: "target_not_in_room",
    })
    expect(test.stored().messages).toHaveLength(0)
  })
})
