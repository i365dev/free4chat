import { describe, expect, it } from "vitest"

import {
  NO_MEETING_NOTES,
  NO_VOICE_REPLY,
  startMeetingNotes,
  startVoiceReply,
} from "./meetingNotesAuth"
import { RoomSession } from "./RoomSession"
import type { RoomParticipant } from "../room/types"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function storedHuman(
  id: string,
  token: string,
  sessionId: string,
  tracks: Array<{ trackName: string; kind: "audio" | "video" }>,
  connected = true
): Record<string, unknown> {
  return {
    id,
    name: id,
    kind: "human",
    connected,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token,
    // Legacy flattened Human media shape, exactly as persisted.
    sessionId,
    muted: false,
    fileChannelReady: true,
    tracks,
  }
}

function buildStoredRoom(grants: {
  meetingNotesFor?: string
  voiceReplyFor?: string
}) {
  return {
    createdAt: Date.now(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": storedHuman("human-1", "tok-h1", "hsess", [
        { trackName: "mic", kind: "audio" },
      ]),
      "human-2": storedHuman("human-2", "tok-h2", "vsess", [
        { trackName: "screen", kind: "video" },
      ]),
      "agent-a": {
        id: "agent-a",
        name: "Agent",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-a",
        media: {
          sessionId: "asess",
          muted: true,
          fileChannelReady: false,
          tracks: [],
          agentSubscribedMids: [],
        },
      },
    },
    messages: [],
    nextMessageSequence: 1,
    meetingNotes:
      grants.meetingNotesFor === "agent-a"
        ? startMeetingNotes("agent-a", 1000)
        : NO_MEETING_NOTES,
    voiceReply:
      grants.voiceReplyFor === "agent-a"
        ? startVoiceReply("agent-a", 1000)
        : NO_VOICE_REPLY,
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
  }
  const rs = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  return {
    authorize(body: Record<string, unknown>): Promise<{
      status: number
      json: Record<string, unknown>
    }> {
      return rs
        .fetch(
          new Request("https://room/control", {
            method: "POST",
            body: JSON.stringify({ action: "authorize", ...body }),
          })
        )
        .then(async (response) => ({
          status: response.status,
          json: (await response.json()) as Record<string, unknown>,
        }))
    },
  }
}

describe("RoomSession authorize — real DO agent matrix (#83 review P1)", () => {
  const room = buildStoredRoom({
    meetingNotesFor: "agent-a",
    voiceReplyFor: "agent-a",
  })

  it("agent-transport datachannels/close correlation (dataChannelSessionId) passes", async () => {
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      purpose: "agent-transport",
      dataChannelSessionId: "hsess",
    })
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: true, kind: "agent" })
  })

  it("bare agent-transport bootstrap passes", async () => {
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      purpose: "agent-transport",
    })
    expect(result.status).toBe(200)
    expect(result.json.ok).toBe(true)
  })

  it("agent-transport with a track target still fails closed", async () => {
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      purpose: "agent-transport",
      trackSessionId: "hsess",
      trackName: "mic",
    })
    expect(result.status).toBe(403)
    expect(result.json.error).toBe("agent_media_direction_forbidden")
  })

  it("agent-transport with a local publish direction still fails closed", async () => {
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      purpose: "agent-transport",
      localTrackCount: 1,
    })
    expect(result.status).toBe(403)
    expect(result.json.error).toBe("agent_media_direction_forbidden")
  })

  it("meeting-notes remote subscribe direction passes under an MN grant", async () => {
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      sessionId: "asess",
      purpose: "meeting-notes",
      remoteTrackCount: 1,
    })
    expect(result.status).toBe(200)
    expect(result.json.kind).toBe("agent")
  })

  it("meeting-notes exact-track reauth rejects Human VIDEO targets (P1-era B2 guard)", async () => {
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      sessionId: "asess",
      purpose: "meeting-notes",
      trackSessionId: "vsess",
      trackName: "screen",
    })
    expect(result.status).toBe(404)
    expect(result.json.error).toBe("track_not_found")
  })

  it("meeting-notes exact-track reauth rejects another Agent's published audio", async () => {
    // A second agent whose published voice track must not be subscribable.
    room.participants["agent-b"] = {
      ...(room.participants["agent-a"] as RoomParticipant),
      id: "agent-b",
      name: "Agent B",
      token: "tok-b",
      media: {
        sessionId: "bsess",
        muted: true,
        fileChannelReady: false,
        tracks: [{ trackName: "agent-voice", kind: "audio" }],
        agentPublishedMid: "pub-b",
        agentSubscribedMids: [],
      },
    } as RoomParticipant
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      sessionId: "asess",
      purpose: "meeting-notes",
      trackSessionId: "bsess",
      trackName: "agent-voice",
    })
    expect(result.status).toBe(404)
    expect(result.json.error).toBe("track_not_found")
  })

  it("voice-reply publish direction passes under a VR grant", async () => {
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      sessionId: "asess",
      purpose: "voice-reply",
      wantsVoicePublish: true,
      localTrackCount: 1,
    })
    expect(result.status).toBe(200)
    expect(result.json.kind).toBe("agent")
  })

  it("a Human plain authorize needs no purpose (browser paths unaffected)", async () => {
    const { authorize } = makeRoomSession(room)
    const result = await authorize({
      participantId: "human-1",
      token: "tok-h1",
    })
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: true, kind: "human" })
  })

  it("an Agent without either grant fails closed even for transport correlation", async () => {
    const noGrants = buildStoredRoom({})
    const { authorize } = makeRoomSession(noGrants)
    const result = await authorize({
      participantId: "agent-a",
      token: "tok-a",
      purpose: "agent-transport",
      dataChannelSessionId: "hsess",
    })
    expect(result.status).toBe(403)
    expect(result.json.error).toBe("agent_media_not_authorized")
  })
})
