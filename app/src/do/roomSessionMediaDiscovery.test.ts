import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #228 media authorization matrix: the agent-room-media discovery denial is
// the STABLE Voice-only contract (meeting_notes_not_authorized), while
// Meeting Notes / Live Transcript producers keep Human-media discovery and
// ungranted agents are denied identically.

const HOST_ID = "11111111-2222-3333-4444-555555555555"

function buildStoredRoom() {
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
        media: {
          sessionId: "hsess",
          muted: false,
          fileChannelReady: true,
          tracks: [{ trackName: "mic", kind: "audio" }],
        },
      },
      "agent-voice": {
        id: "agent-voice",
        name: "Voice-Agent",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-av",
        runtimeHostId: HOST_ID,
      },
      "agent-mn": {
        id: "agent-mn",
        name: "Notes-Agent",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-mn",
      },
      "agent-none": {
        id: "agent-none",
        name: "Text-Agent",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-none",
      },
    },
    meetingNotes: { active: false },
    agentVoice: { "agent-voice": { enabledAt: 12345 } },
    messages: [],
    nextMessageSequence: 1,
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
    getWebSockets: () => [] as WebSocket[],
  }
  const rs = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      AGENT_MEDIA_ENABLED: "true",
    } as never
  )
  const roomMedia = (participantId: string, token: string) =>
    rs
      .fetch(
        new Request("https://room/control", {
          method: "POST",
          body: JSON.stringify({
            action: "agent-room-media",
            participantId,
            token,
          }),
        })
      )
      .then(async (response) => ({
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
      }))
  return { roomMedia }
}

describe("agent-room-media authorization matrix (#228)", () => {
  it("denies Human-media discovery to a Voice-only Agent with the STABLE legacy denial code", async () => {
    const { roomMedia } = makeRoomSession(buildStoredRoom())
    const denied = await roomMedia("agent-voice", "tok-av")
    expect(denied.status).toBe(403)
    // #228: the deployed Runtime generation recognizes THIS exact code as
    // the expected Voice-only refusal — changing it re-breaks voice
    // bootstrap on every deployed Runtime.
    expect(denied.json.error).toBe("meeting_notes_not_authorized")
  })

  it("keeps Human-media discovery available to the Meeting Notes note-taker", async () => {
    const stored = buildStoredRoom()
    ;(stored.meetingNotes as Record<string, unknown>).active = true
    ;(stored.meetingNotes as Record<string, unknown>).agentParticipantId =
      "agent-mn"
    ;(stored.meetingNotes as Record<string, unknown>).startedAt = 123
    const { roomMedia } = makeRoomSession(stored)
    const allowed = await roomMedia("agent-mn", "tok-mn")
    expect(allowed.status).toBe(200)
    const participants = allowed.json.participants as Array<
      Record<string, unknown>
    >
    // Human media identifiers flow to the authorized note-taker only.
    expect(participants.find((p) => p.participantId === "human-1")).toBeTruthy()
    // Voice-only Agent still cannot obtain Human media identifiers.
    expect(
      participants.find((p) => p.participantId === "agent-voice")
    ).toBeUndefined()
  })

  it("denies an ungranted Agent identically", async () => {
    const { roomMedia } = makeRoomSession(buildStoredRoom())
    const denied = await roomMedia("agent-none", "tok-none")
    expect(denied.status).toBe(403)
    expect(denied.json.error).toBe("meeting_notes_not_authorized")
  })
})
