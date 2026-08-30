import { describe, expect, it, vi } from "vitest"

import { MAX_LIVE_TRANSCRIPT_SEGMENT_TEXT_CHARS } from "./liveTranscript"
import { RoomSession } from "./RoomSession"
import { hashRuntimeProviderHandle } from "../common/runtimeProviderCredential"

const FUTURE = Date.now() + 60_000
const HOST_A = "host-live-stt-a"
const HOST_B = "host-live-stt-b"
const PROVIDER_HANDLE_A = "A".repeat(43)
const PROVIDER_HANDLE_B = "B".repeat(43)

function participant(
  id: string,
  kind: "human" | "agent",
  runtimeHostId?: string
) {
  return {
    id,
    name: id === "human" ? "Human One" : id,
    kind,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
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

async function roomFixture({
  includeTranscript = true,
  mediaEnabled = true,
}: {
  includeTranscript?: boolean
  mediaEnabled?: boolean
} = {}) {
  const roomId = "room-live-transcript"
  const providerHandleHashA = await hashRuntimeProviderHandle(
    roomId,
    HOST_A,
    PROVIDER_HANDLE_A
  )
  const providerHandleHashB = await hashRuntimeProviderHandle(
    roomId,
    HOST_B,
    PROVIDER_HANDLE_B
  )
  return {
    roomId,
    mediaEnabled,
    room: {
      createdAt: Date.now(),
      expiresAt: FUTURE,
      participants: {
        human: participant("human", "human"),
        other: participant("other", "human"),
        producer: participant("producer", "agent", HOST_A),
        "copied-host": participant("copied-host", "agent", HOST_A),
        secondary: participant("secondary", "agent", HOST_B),
      },
      runtimeHosts: {
        [HOST_A]: {
          runtimeHostId: HOST_A,
          speech: { stt: true, tts: false },
        },
        [HOST_B]: {
          runtimeHostId: HOST_B,
          speech: { stt: true, tts: false },
        },
      },
      runtimeHostProviders: {
        [HOST_A]: {
          humanParticipantId: "human",
          claimedAt: 1,
          providerHandleHash: providerHandleHashA,
          verifiedParticipantIds: ["producer"],
        },
        [HOST_B]: {
          humanParticipantId: "other",
          claimedAt: 1,
          providerHandleHash: providerHandleHashB,
          verifiedParticipantIds: ["secondary"],
        },
      },
      runtimeHostProviderClaims: {},
      messages: [],
      ...(includeTranscript
        ? {
            liveTranscript: { active: false },
            liveTranscriptSegments: [],
            nextLiveTranscriptEpoch: 1,
            nextTranscriptSequence: 1,
          }
        : {}),
      attachments: [],
      nextMessageSequence: 0,
      meetingNotes: { active: false },
      agentVoice: {},
      pendingMediaCleanup: [],
    },
  }
}

async function harness(options?: {
  includeTranscript?: boolean
  mediaEnabled?: boolean
}) {
  const fixture = await roomFixture(options)
  const store = new Map<string, unknown>([["room", fixture.room]])
  const ctx = {
    id: { toString: () => fixture.roomId },
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
  const session = new RoomSession(
    ctx as never,
    {
      SFU_ROOM: {},
      ...(fixture.mediaEnabled ? { AGENT_MEDIA_ENABLED: "true" } : {}),
    } as never
  )
  const socket = { send: vi.fn(), close: vi.fn() }
  const sendHuman = (id: string, message: object) =>
    (session as any).handleClientMessage(
      socket,
      { participantId: id, token: `${id}-token`, connectionNonce: "n" },
      message
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
  const append = (overrides: Record<string, unknown> = {}) =>
    control({
      action: "agent-live-transcript-append",
      participantId: "producer",
      token: "producer-token",
      epoch: 1,
      segmentId: "segment-1",
      sourceParticipantId: "human",
      text: "We agreed on the plan.",
      ...overrides,
    })
  const stored = () => store.get("room") as any
  return { session, socket, store, sendHuman, control, append, stored }
}

describe("RoomSession Live Transcript control-plane (#177 PR1)", () => {
  it("starts only for the associated STT-ready Host and keeps a single producer", async () => {
    const room = await harness()
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    expect(room.stored().liveTranscript).toMatchObject({
      active: true,
      producerRuntimeHostId: HOST_A,
      startedByHumanParticipantId: "human",
      epoch: 1,
    })
    expect(room.stored().nextLiveTranscriptEpoch).toBe(2)
    expect(room.stored().nextMessageSequence).toBe(0)

    // A concurrent/near-concurrent second Start observes the first producer;
    // it cannot replace it or allocate a second epoch.
    await room.sendHuman("other", {
      type: "live-transcript-start",
      runtimeHostId: HOST_B,
    })
    expect(room.stored().liveTranscript).toMatchObject({
      producerRuntimeHostId: HOST_A,
      epoch: 1,
    })
    expect(room.stored().nextLiveTranscriptEpoch).toBe(2)

    await room.sendHuman("human", { type: "live-transcript-stop" })
    await room.sendHuman("other", {
      type: "live-transcript-start",
      runtimeHostId: HOST_B,
    })
    expect(room.stored().liveTranscript).toMatchObject({
      producerRuntimeHostId: HOST_B,
      startedByHumanParticipantId: "other",
      epoch: 2,
    })
  })

  it("rejects unavailable media, an unbound/copied Host, wrong association, and STT false", async () => {
    const mediaOff = await harness({ mediaEnabled: false })
    await mediaOff.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    expect(mediaOff.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", error: "live_transcript_media_disabled" })
    )

    const room = await harness()
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_B,
    })
    expect(room.stored().liveTranscript).toEqual({ active: false })
    expect(room.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", error: "live_transcript_unavailable" })
    )

    room.stored().runtimeHosts["host-unbound"] = {
      runtimeHostId: "host-unbound",
      speech: { stt: true, tts: false },
    }
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: "host-unbound",
    })
    expect(room.stored().liveTranscript).toEqual({ active: false })

    room.stored().runtimeHosts[HOST_A].speech.stt = false
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    expect(room.stored().liveTranscript).toEqual({ active: false })
  })

  it("lets any current Human stop and normalizes true producer loss to Off", async () => {
    const room = await harness()
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    await room.sendHuman("other", { type: "live-transcript-stop" })
    expect(room.stored().liveTranscript).toEqual({ active: false })

    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    const noStt = await room.control({
      action: "agent-update-runtime-host",
      participantId: "producer",
      token: "producer-token",
      runtimeHost: {
        runtimeHostId: HOST_A,
        speech: { stt: false, tts: false },
      },
      runtimeProviderHandle: PROVIDER_HANDLE_A,
    })
    expect(noStt.status).toBe(200)
    expect(room.stored().liveTranscript).toEqual({ active: false })

    room.stored().runtimeHosts[HOST_A].speech.stt = true
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    const departed = await room.control({
      action: "agent-leave",
      participantId: "producer",
      token: "producer-token",
    })
    expect(departed.status).toBe(200)
    expect(room.stored().liveTranscript).toEqual({ active: false })

    const humanDeparture = await harness()
    await humanDeparture.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    await humanDeparture.sendHuman("human", { type: "leave" })
    expect(humanDeparture.stored().runtimeHostProviders[HOST_A]).toBeUndefined()
    expect(humanDeparture.stored().liveTranscript).toEqual({ active: false })
  })

  it("authorizes only the verified producer, appends safe shared context, and deduplicates", async () => {
    const room = await harness()
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    const copied = await room.append({
      participantId: "copied-host",
      token: "copied-host-token",
    })
    expect(copied).toMatchObject({
      status: 403,
      json: { error: "live_transcript_not_authorized" },
    })
    const differentHost = await room.append({
      participantId: "secondary",
      token: "secondary-token",
    })
    expect(differentHost.status).toBe(403)

    const first = await room.append()
    expect(first).toMatchObject({
      status: 200,
      json: {
        duplicate: false,
        segment: expect.objectContaining({
          epoch: 1,
          sequence: 1,
          participantId: "human",
          speaker: "Human One",
        }),
      },
    })
    const duplicate = await room.append()
    expect(duplicate).toMatchObject({ status: 200, json: { duplicate: true } })
    expect(room.stored().liveTranscriptSegments).toHaveLength(1)
    expect(room.stored().nextTranscriptSequence).toBe(2)

    const invalidSource = await room.append({
      segmentId: "segment-invalid-source",
      sourceParticipantId: "producer",
    })
    expect(invalidSource.status).toBe(400)
    const oversized = await room.append({
      segmentId: "segment-oversized",
      text: "x".repeat(MAX_LIVE_TRANSCRIPT_SEGMENT_TEXT_CHARS + 1),
    })
    expect(oversized.status).toBe(400)

    const info = await room.control({ action: "room-info" })
    expect((info.json as any).liveTranscriptSegments).toHaveLength(1)
    expect(JSON.stringify(info.json)).not.toContain(PROVIDER_HANDLE_A)
    expect(JSON.stringify(info.json)).not.toContain("providerHandleHash")
    const state = (room.session as any).stateFor(room.stored())
    expect(state.liveTranscriptSegments).toHaveLength(1)
    expect(JSON.stringify(state)).not.toContain(PROVIDER_HANDLE_A)
    expect(JSON.stringify(state)).not.toContain("providerHandleHash")
  })

  it("rejects a stale callback after Stop and restart without allocating a transcript sequence", async () => {
    const room = await harness()
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    await room.sendHuman("human", { type: "live-transcript-stop" })
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    const stale = await room.append({ epoch: 1 })
    expect(stale).toMatchObject({
      status: 409,
      json: { error: "live_transcript_epoch_mismatch" },
    })
    expect(room.stored().liveTranscriptSegments).toEqual([])
    expect(room.stored().nextTranscriptSequence).toBe(1)
  })

  it("never creates an ordinary event or wakes an Agent waiter", async () => {
    const room = await harness()
    await room.sendHuman("human", {
      type: "live-transcript-start",
      runtimeHostId: HOST_A,
    })
    let settled = false
    const waiter = room.control({
      action: "agent-wait",
      participantId: "secondary",
      token: "secondary-token",
      cursor: 0,
      timeoutSeconds: 10,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const activeWaiter = (room.session as any).agentWaiters.get("secondary")
    expect(activeWaiter).toBeTruthy()

    const append = await room.append()
    void waiter.then(() => {
      settled = true
    })
    await Promise.resolve()
    clearTimeout(activeWaiter.timer)
    ;(room.session as any).agentWaiters.delete("secondary")
    expect(append.status).toBe(200)
    expect(room.stored().messages).toEqual([])
    expect(room.stored().nextMessageSequence).toBe(0)
    expect(settled).toBe(false)
  })

  it("migrates a stored pre-#177 Room to an Off, empty, usable projection", async () => {
    const room = await harness({ includeTranscript: false })
    const info = await room.control({ action: "room-info" })
    expect(info.status).toBe(200)
    expect((info.json as any).liveTranscript).toEqual({ active: false })
    expect((info.json as any).liveTranscriptSegments).toEqual([])
    expect(room.stored()).toMatchObject({
      liveTranscript: { active: false },
      liveTranscriptSegments: [],
      nextLiveTranscriptEpoch: 1,
      nextTranscriptSequence: 1,
    })
  })
})
