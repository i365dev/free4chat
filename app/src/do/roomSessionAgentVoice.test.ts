import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"

const future = Date.now() + 60_000

function participant(id: string, kind: "human" | "agent", host?: string) {
  return {
    id,
    name: id,
    kind,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    ...(host ? { runtimeHostId: host } : {}),
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

function roomFixture() {
  return {
    createdAt: Date.now(),
    expiresAt: future,
    participants: {
      human: participant("human", "human"),
      "human-2": participant("human-2", "human"),
      pi: participant("pi", "agent", "host-ready"),
      codex: participant("codex", "agent", "host-ready"),
      claude: participant("claude", "agent", "host-unready"),
      hermes: participant("hermes", "agent", "host-secondary"),
      "no-host": participant("no-host", "agent"),
    },
    runtimeHosts: {
      "host-ready": {
        runtimeHostId: "host-ready",
        speech: { stt: false, tts: true },
      },
      "host-unready": {
        runtimeHostId: "host-unready",
        speech: { stt: false, tts: false },
      },
      "host-secondary": {
        runtimeHostId: "host-secondary",
        speech: { stt: false, tts: true },
      },
    },
    messages: [],
    attachments: [],
    nextMessageSequence: 0,
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

function harness() {
  const store = new Map<string, unknown>([["room", roomFixture()]])
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
  }
  const session = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      AGENT_MEDIA_ENABLED: "true",
    } as never
  )
  vi.spyOn(session as any, "broadcastState").mockResolvedValue(undefined)
  vi.spyOn(session as any, "scheduleNextAlarm").mockResolvedValue(undefined)
  vi.spyOn(session as any, "attemptCleanupNow").mockResolvedValue(undefined)
  const socket = { send: vi.fn(), close: vi.fn() }
  const sendFrom = async (
    participantId: string,
    agentParticipantId: string,
    enabled: boolean
  ) =>
    (session as any).handleClientMessage(
      socket,
      {
        participantId,
        token: `${participantId}-token`,
        connectionNonce: "n",
      },
      { type: "agent-voice-set", agentParticipantId, enabled }
    )
  const send = (agentParticipantId: string, enabled: boolean) =>
    sendFrom("human", agentParticipantId, enabled)
  const action = (body: Record<string, unknown>) =>
    session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
  return { session, socket, store, send, sendFrom, action }
}

describe("RoomSession Agent Voice", () => {
  it("enables multiple ready Agents independently and preserves enable epochs", async () => {
    const { send, store } = harness()
    await send("pi", true)
    const first = (store.get("room") as any).agentVoice.pi.enabledAt
    await send("codex", true)
    await send("pi", true)
    const room = store.get("room") as any
    expect(room.agentVoice).toMatchObject({
      pi: { enabled: true, enabledAt: first },
      codex: { enabled: true },
    })
    expect(room.nextMessageSequence).toBe(0)

    await send("pi", false)
    expect((store.get("room") as any).agentVoice).toEqual({
      codex: expect.objectContaining({ enabled: true }),
    })
  })

  it("fails closed for an Agent whose Runtime Host TTS is unavailable", async () => {
    const { send, socket, store } = harness()
    await send("claude", true)
    expect((store.get("room") as any).agentVoice).toEqual({})
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", error: "voice_unavailable" })
    )
  })

  it("does not enable an Agent without a Runtime Host", async () => {
    const { send, socket, store } = harness()
    await send("no-host", true)
    expect((store.get("room") as any).agentVoice).toEqual({})
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", error: "voice_unavailable" })
    )
  })

  it("rejects a new enable while media cleanup is backpressured", async () => {
    const { send, socket, store } = harness()
    const room = store.get("room") as any
    room.pendingMediaCleanup = Array.from({ length: 16 }, (_, index) => ({
      sessionId: `stuck-${index}`,
      mids: ["mid"],
    }))
    await send("pi", true)
    expect((store.get("room") as any).agentVoice).toEqual({})
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "error",
        error: "agent_media_cleanup_backlog",
      })
    )
  })

  it("lets any current Human disable just one enabled Agent", async () => {
    const { send, sendFrom, store } = harness()
    await send("pi", true)
    await send("codex", true)
    await sendFrom("human-2", "pi", false)
    expect((store.get("room") as any).agentVoice).toEqual({
      codex: expect.objectContaining({ enabled: true }),
    })
  })

  it("revokes every host member when a Runtime Host loses TTS readiness", async () => {
    const { send, action, store } = harness()
    await send("pi", true)
    await send("codex", true)
    await send("hermes", true)
    const response = await action({
      action: "agent-update-runtime-host",
      participantId: "pi",
      token: "pi-token",
      runtimeHost: {
        runtimeHostId: "host-ready",
        speech: { stt: false, tts: false },
      },
    })
    expect(response.status).toBe(200)
    expect((store.get("room") as any).agentVoice).toEqual({
      hermes: expect.objectContaining({ enabled: true }),
    })
  })

  it("does not restore revoked grants when readiness recovers", async () => {
    const { send, action, store } = harness()
    await send("pi", true)
    await action({
      action: "agent-update-runtime-host",
      participantId: "pi",
      token: "pi-token",
      runtimeHost: {
        runtimeHostId: "host-ready",
        speech: { stt: false, tts: false },
      },
    })
    await action({
      action: "agent-update-runtime-host",
      participantId: "pi",
      token: "pi-token",
      runtimeHost: {
        runtimeHostId: "host-ready",
        speech: { stt: false, tts: true },
      },
    })
    expect((store.get("room") as any).agentVoice).toEqual({})
  })

  it("revokes on host switch and on Agent leave", async () => {
    const { send, action, store } = harness()
    await send("pi", true)
    await action({
      action: "agent-update-runtime-host",
      participantId: "pi",
      token: "pi-token",
      runtimeHost: {
        runtimeHostId: "host-secondary",
        speech: { stt: false, tts: true },
      },
    })
    expect((store.get("room") as any).agentVoice).toEqual({})
    await send("pi", true)
    const leave = await action({
      action: "agent-leave",
      participantId: "pi",
      token: "pi-token",
    })
    expect(leave.status).toBe(200)
    expect((store.get("room") as any).agentVoice).toEqual({})
  })

  it("scrubs malformed state and stages legacy RTP before dropping singleton voice", () => {
    const { session } = harness()
    const stored = roomFixture() as any
    stored.participants.pi.media = {
      sessionId: "pi-session",
      muted: true,
      fileChannelReady: false,
      tracks: [{ trackName: "agent-voice", kind: "audio" }],
      agentPublishedMid: "legacy-published-mid",
      agentPublishedTrackName: "agent-voice",
    }
    const normalized = (session as any).normalizeRoom({
      ...stored,
      voiceReply: {
        active: true,
        agentParticipantId: "pi",
        startedAt: 1,
      },
      agentVoice: {
        pi: { enabled: true, enabledAt: "bad" },
        missing: { enabled: true, enabledAt: 1 },
      },
    })
    expect(normalized.changed).toBe(true)
    expect(normalized.room.agentVoice).toEqual({})
    expect(normalized.room.pendingMediaCleanup).toEqual([
      { sessionId: "pi-session", mids: ["legacy-published-mid"] },
    ])
    expect(
      normalized.room.participants.pi.media.agentPublishedMid
    ).toBeUndefined()
    expect(normalized.room.participants.pi.media.tracks).toEqual([])
  })
})
