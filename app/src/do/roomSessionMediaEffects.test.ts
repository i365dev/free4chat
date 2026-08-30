import { afterEach, describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function roomFixture(): RoomRecord {
  return {
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    participants: {
      agent: {
        id: "agent",
        name: "Agent",
        kind: "agent" as const,
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "agent-token",
        runtimeHostId: "host-a",
        media: {
          sessionId: "session-old",
          muted: true,
          fileChannelReady: false,
          tracks: [{ trackName: "agent-voice", kind: "audio" as const }],
          agentPublishedMid: "mid-old",
          agentPublishedTrackName: "agent-voice",
        },
      },
    },
    runtimeHosts: {
      "host-a": {
        runtimeHostId: "host-a",
        speech: { stt: false, tts: true },
      },
    },
    messages: [],
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    nextLiveTranscriptEpoch: 1,
    nextTranscriptSequence: 1,
    attachments: [],
    nextMessageSequence: 0,
    meetingNotes: { active: false },
    agentVoice: { agent: { enabled: true as const, enabledAt: 1 } },
    pendingMediaCleanup: [{ sessionId: "session-old", mids: ["mid-old"] }],
  }
}

function harness(initial: RoomRecord = roomFixture()) {
  let room = clone(initial)
  let transcript = {
    liveTranscript: room.liveTranscript,
    liveTranscriptSegments: room.liveTranscriptSegments,
    nextLiveTranscriptEpoch: room.nextLiveTranscriptEpoch,
    nextTranscriptSequence: room.nextTranscriptSequence,
  }
  delete (room as Partial<RoomRecord>).liveTranscript
  delete (room as Partial<RoomRecord>).liveTranscriptSegments
  delete (room as Partial<RoomRecord>).nextLiveTranscriptEpoch
  delete (room as Partial<RoomRecord>).nextTranscriptSequence
  const writes: RoomRecord[] = []
  const readRoom = (): RoomRecord => clone({ ...room, ...transcript })
  const replace = (next: RoomRecord) => {
    const copied = clone(next)
    transcript = {
      liveTranscript: copied.liveTranscript,
      liveTranscriptSegments: copied.liveTranscriptSegments,
      nextLiveTranscriptEpoch: copied.nextLiveTranscriptEpoch,
      nextTranscriptSequence: copied.nextTranscriptSequence,
    }
    delete (copied as Partial<RoomRecord>).liveTranscript
    delete (copied as Partial<RoomRecord>).liveTranscriptSegments
    delete (copied as Partial<RoomRecord>).nextLiveTranscriptEpoch
    delete (copied as Partial<RoomRecord>).nextTranscriptSequence
    room = copied
  }
  const ctx = {
    storage: {
      get: async (key: string) =>
        clone(key === "live-transcript" ? transcript : room),
      put: async (key: string, value: unknown) => {
        if (key === "live-transcript")
          transcript = clone(value) as typeof transcript
        else room = clone(value) as typeof room
        writes.push(readRoom())
      },
      delete: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [],
  }
  const session = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      SFU_APP_ID: "app-id",
      SFU_APP_SECRET: "secret",
      AGENT_MEDIA_ENABLED: "true",
    } as never
  )
  return {
    session,
    writes,
    room: readRoom,
    replaceRoom: replace,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe("RoomSession media effect lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("persists a grant revocation and its exact cleanup before tracks/close runs", async () => {
    const { session, room } = harness()
    const fetchMock = vi.fn(async () => {
      const durableBeforeClose = room()
      expect(durableBeforeClose.participants.agent).toBeUndefined()
      expect(durableBeforeClose.agentVoice).toEqual({})
      expect(durableBeforeClose.pendingMediaCleanup).toEqual([
        { sessionId: "session-old", mids: ["mid-old"] },
      ])
      return new Response("", { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify({
          action: "agent-leave",
          participantId: "agent",
          token: "agent-token",
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(room().pendingMediaCleanup).toEqual([])
  })

  it("reloads fresh Room state and reconciles only the completed effect after an interleaved mutation", async () => {
    const { session, room, replaceRoom } = harness()
    const close = deferred<Response>()
    const fetchMock = vi.fn(async () => close.promise)
    vi.stubGlobal("fetch", fetchMock)

    const initial = room()
    const cleanup = (session as any).attemptCleanupNow(
      initial.pendingMediaCleanup
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const interleaved = room()
    replaceRoom({
      ...interleaved,
      participants: {
        ...interleaved.participants,
        agent: {
          ...interleaved.participants.agent!,
          media: {
            sessionId: "session-new",
            muted: true,
            fileChannelReady: false,
            tracks: [],
          },
        },
        human: {
          id: "human",
          name: "Human",
          kind: "human",
          connected: true,
          joinedAt: 2,
          lastSeenAt: 2,
          token: "human-token",
          media: {
            sessionId: "session-human",
            muted: false,
            fileChannelReady: false,
            tracks: [],
          },
        },
      },
      pendingMediaCleanup: [
        ...interleaved.pendingMediaCleanup,
        { sessionId: "session-new", mids: ["mid-new"] },
      ],
    })
    close.resolve(new Response("", { status: 200 }))
    await cleanup

    expect(room().participants.human).toMatchObject({ name: "Human" })
    expect(room().participants.agent?.media?.sessionId).toBe("session-new")
    expect(room().pendingMediaCleanup).toEqual([
      { sessionId: "session-new", mids: ["mid-new"] },
    ])
  })
})
