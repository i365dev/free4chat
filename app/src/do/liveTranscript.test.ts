import { describe, expect, it } from "vitest"

import {
  appendLiveTranscriptSegment,
  canAgentAppendLiveTranscript,
  canHumanStartLiveTranscript,
  MAX_LIVE_TRANSCRIPT_SEGMENTS,
  MAX_LIVE_TRANSCRIPT_STORAGE_BYTES,
  liveTranscriptStorageByteLength,
  normalizeLiveTranscriptProducer,
  normalizeStoredLiveTranscript,
  startLiveTranscript,
  stopLiveTranscript,
} from "./liveTranscript"

const HOST = "host-live-transcript"
const ACTIVE = {
  active: true as const,
  producerRuntimeHostId: HOST,
  epoch: 7,
  startedAt: 100,
}

const participants = [
  {
    id: "human",
    name: "Human",
    kind: "human" as const,
    connected: true,
  },
  {
    id: "producer",
    name: "Producer",
    kind: "agent" as const,
    connected: true,
    runtimeHostId: HOST,
  },
  {
    id: "copied-host",
    name: "Copied host",
    kind: "agent" as const,
    connected: true,
    runtimeHostId: HOST,
  },
]

const runtimeHosts = {
  [HOST]: { runtimeHostId: HOST, speech: { stt: true, tts: false } },
}

describe("Live Transcript domain", () => {
  it("normalizes legacy Rooms to an Off, empty, allocation-ready state", () => {
    expect(
      normalizeStoredLiveTranscript({
        liveTranscript: undefined,
        liveTranscriptSegments: undefined,
        nextLiveTranscriptEpoch: undefined,
        nextTranscriptSequence: undefined,
      })
    ).toMatchObject({
      liveTranscript: { active: false },
      liveTranscriptSegments: [],
      nextLiveTranscriptEpoch: 1,
      nextTranscriptSequence: 1,
      changed: true,
    })
  })

  it("allocates a fresh Room-local epoch only on a new activation", () => {
    const started = startLiveTranscript({
      liveTranscript: { active: false },
      nextLiveTranscriptEpoch: 3,
      runtimeHostId: HOST,
      now: 100,
    })
    expect(started).toMatchObject({
      liveTranscript: { ...ACTIVE, epoch: 3, startedAt: 100 },
      nextLiveTranscriptEpoch: 4,
      idempotent: false,
    })

    const replay = startLiveTranscript({
      liveTranscript: started.liveTranscript,
      nextLiveTranscriptEpoch: started.nextLiveTranscriptEpoch,
      runtimeHostId: "other-host",
      now: 200,
    })
    expect(replay).toMatchObject({
      liveTranscript: started.liveTranscript,
      nextLiveTranscriptEpoch: 4,
      idempotent: true,
    })

    const restarted = startLiveTranscript({
      liveTranscript: stopLiveTranscript(started.liveTranscript),
      nextLiveTranscriptEpoch: replay.nextLiveTranscriptEpoch,
      runtimeHostId: HOST,
      now: 300,
    })
    expect(restarted.liveTranscript).toMatchObject({ epoch: 4, startedAt: 300 })
  })

  it("authorizes an authenticated Human's explicit Start for any connected STT-ready Host", () => {
    expect(
      canHumanStartLiveTranscript({
        participants,
        runtimeHosts,
        humanParticipantId: "human",
        runtimeHostId: HOST,
      })
    ).toBe(true)
    expect(
      canHumanStartLiveTranscript({
        participants: participants.map((participant) =>
          participant.id === "human"
            ? { ...participant, connected: false }
            : participant
        ),
        runtimeHosts,
        humanParticipantId: "human",
        runtimeHostId: HOST,
      })
    ).toBe(false)
    expect(
      canHumanStartLiveTranscript({
        participants,
        runtimeHosts,
        humanParticipantId: "human",
        runtimeHostId: "unavailable-host",
      })
    ).toBe(false)
    expect(
      canHumanStartLiveTranscript({
        participants: participants.map((participant) =>
          participant.kind === "agent"
            ? { ...participant, connected: false }
            : participant
        ),
        runtimeHosts,
        humanParticipantId: "human",
        runtimeHostId: HOST,
      })
    ).toBe(false)
  })

  it("keeps a producer through a transient Human reconnect but fails closed on genuine loss", () => {
    expect(
      normalizeLiveTranscriptProducer({
        liveTranscript: ACTIVE,
        participants: participants.map((participant) =>
          participant.id === "human"
            ? { ...participant, connected: false }
            : participant
        ),
        runtimeHosts,
      })
    ).toEqual({ liveTranscript: ACTIVE, changed: false })

    expect(
      normalizeLiveTranscriptProducer({
        liveTranscript: ACTIVE,
        participants,
        runtimeHosts: {
          [HOST]: { runtimeHostId: HOST, speech: { stt: false, tts: false } },
        },
      })
    ).toEqual({ liveTranscript: { active: false }, changed: true })

    expect(
      normalizeLiveTranscriptProducer({
        liveTranscript: ACTIVE,
        participants,
        runtimeHosts,
        mediaAvailable: false,
      })
    ).toEqual({ liveTranscript: { active: false }, changed: true })

    expect(
      normalizeLiveTranscriptProducer({
        liveTranscript: ACTIVE,
        participants: participants.filter(
          (participant) =>
            participant.id !== "producer" && participant.id !== "copied-host"
        ),
        runtimeHosts,
      })
    ).toEqual({ liveTranscript: { active: false }, changed: true })
  })

  it("routes transcript production to a connected member of the selected Host", () => {
    expect(
      canAgentAppendLiveTranscript({
        liveTranscript: ACTIVE,
        caller: participants[1]!,
        participants,
        runtimeHosts,
      })
    ).toBe(true)
    expect(
      canAgentAppendLiveTranscript({
        liveTranscript: ACTIVE,
        caller: participants[2]!,
        participants,
        runtimeHosts,
      })
    ).toBe(true)
    expect(
      canAgentAppendLiveTranscript({
        liveTranscript: ACTIVE,
        caller: {
          id: "copied-id",
          kind: "agent",
          runtimeHostId: HOST,
        },
        participants,
        runtimeHosts,
      })
    ).toBe(false)
  })

  it("deduplicates by epoch and segment id without allocating a second sequence", () => {
    const first = appendLiveTranscriptSegment({
      liveTranscript: ACTIVE,
      liveTranscriptSegments: [],
      nextTranscriptSequence: 9,
      epoch: 7,
      segmentId: "segment-1",
      sourceParticipant: { id: "human", name: "Human", kind: "human" },
      text: "Hello room",
      now: 200,
    })
    expect(first).toMatchObject({
      ok: true,
      duplicate: false,
      nextTranscriptSequence: 10,
      segment: { sequence: 9, speaker: "Human", text: "Hello room" },
    })
    if (!first.ok) throw new Error("expected transcript append")

    const duplicate = appendLiveTranscriptSegment({
      liveTranscript: ACTIVE,
      liveTranscriptSegments: first.liveTranscriptSegments,
      nextTranscriptSequence: first.nextTranscriptSequence,
      epoch: 7,
      segmentId: "segment-1",
      sourceParticipant: { id: "human", name: "Human", kind: "human" },
      text: "ignored duplicate payload",
      now: 201,
    })
    expect(duplicate).toMatchObject({
      ok: true,
      duplicate: true,
      nextTranscriptSequence: 10,
    })
  })

  it("rejects stale epochs and bounds retained committed context from the oldest end", () => {
    expect(
      appendLiveTranscriptSegment({
        liveTranscript: ACTIVE,
        liveTranscriptSegments: [],
        nextTranscriptSequence: 1,
        epoch: 6,
        segmentId: "stale",
        sourceParticipant: { id: "human", name: "Human", kind: "human" },
        text: "old callback",
        now: 1,
      })
    ).toEqual({ ok: false, error: "live_transcript_epoch_mismatch" })

    const segments = Array.from(
      { length: MAX_LIVE_TRANSCRIPT_SEGMENTS + 1 },
      (_, index) => ({
        segmentId: `segment-${index}`,
        epoch: 7,
        sequence: index + 1,
        participantId: "human",
        speaker: "Human",
        text: "x",
        createdAt: index + 1,
      })
    )
    const overflow = appendLiveTranscriptSegment({
      liveTranscript: ACTIVE,
      liveTranscriptSegments: segments,
      nextTranscriptSequence: MAX_LIVE_TRANSCRIPT_SEGMENTS + 2,
      epoch: 7,
      segmentId: "segment-new",
      sourceParticipant: { id: "human", name: "Human", kind: "human" },
      text: "newest",
      now: 999,
    })
    if (!overflow.ok) throw new Error("expected transcript append")
    expect(overflow.liveTranscriptSegments).toHaveLength(
      MAX_LIVE_TRANSCRIPT_SEGMENTS
    )
    expect(overflow.liveTranscriptSegments[0]?.segmentId).toBe("segment-2")
    expect(overflow.liveTranscriptSegments.at(-1)?.segmentId).toBe(
      "segment-new"
    )
    // A character count is not a storage limit: CJK uses three UTF-8 bytes
    // per glyph. The persisted separate value is bounded by its actual JSON
    // UTF-8 representation, evicting oldest committed context first.
    const characterBounded = appendLiveTranscriptSegment({
      liveTranscript: ACTIVE,
      liveTranscriptSegments: Array.from({ length: 30 }, (_, index) => ({
        segmentId: `characters-${index}`,
        epoch: 7,
        sequence: index + 1,
        participantId: "human",
        speaker: "Human",
        text: "语".repeat(4_000),
        createdAt: index + 1,
      })),
      nextTranscriptSequence: 31,
      epoch: 7,
      segmentId: "characters-new",
      sourceParticipant: { id: "human", name: "Human", kind: "human" },
      text: "语".repeat(4_000),
      now: 1_000,
    })
    if (!characterBounded.ok) throw new Error("expected transcript append")
    expect(characterBounded.liveTranscriptSegments.length).toBeGreaterThan(0)
    expect(characterBounded.liveTranscriptSegments).not.toHaveLength(31)
    expect(characterBounded.liveTranscriptSegments[0]?.segmentId).not.toBe(
      "characters-0"
    )
    expect(characterBounded.liveTranscriptSegments.at(-1)?.segmentId).toBe(
      "characters-new"
    )
    expect(
      liveTranscriptStorageByteLength({
        liveTranscript: ACTIVE,
        liveTranscriptSegments: characterBounded.liveTranscriptSegments,
        nextLiveTranscriptEpoch: 8,
        nextTranscriptSequence: characterBounded.nextTranscriptSequence,
      })
    ).toBeLessThanOrEqual(MAX_LIVE_TRANSCRIPT_STORAGE_BYTES)
  })
})
