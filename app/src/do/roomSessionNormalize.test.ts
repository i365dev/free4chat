import { describe, expect, it } from "vitest"

import { NO_VOICE_REPLY, isValidVoiceReplyState } from "./meetingNotesAuth"
import { normalizeAgentParticipantMedia } from "./RoomSession"

const AGENT_ID = "agent-voice-1"
const MID = "pub-mid-1"

function media(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-agent",
    muted: false,
    fileChannelReady: false,
    tracks: [{ trackName: "agent-voice", kind: "audio" }],
    agentPublishedMid: MID,
    ...overrides,
  } as Parameters<typeof normalizeAgentParticipantMedia>[0]
}

function grantedVoice() {
  return {
    active: true,
    agentParticipantId: AGENT_ID,
    startedAt: 1000,
  }
}

describe("normalizeAgentParticipantMedia (#83 live silence fix)", () => {
  it("preserves the authorized single audio track + mid across loads", () => {
    const before = media()
    const result = normalizeAgentParticipantMedia(
      before,
      grantedVoice(),
      AGENT_ID
    )
    expect(result.changed).toBe(false)
    expect(result.media?.tracks).toEqual([
      { trackName: "agent-voice", kind: "audio" },
    ])
    expect(result.media?.agentPublishedMid).toBe(MID)
  })

  it("still strips tracks when voiceReply is inactive (Stop semantics)", () => {
    const inactive = { ...grantedVoice(), active: false }
    const result = normalizeAgentParticipantMedia(media(), inactive, AGENT_ID)
    expect(result.changed).toBe(true)
    expect(result.media?.tracks).toEqual([])
    // Stale mid is cleared too so capacity/revocation bookkeeping cannot
    // reference a dead publication.
    expect(result.media?.agentPublishedMid).toBeUndefined()
  })

  it("preserves a booked publication privately until its first PCM write", () => {
    const pending = media({
      tracks: [],
      agentPublishedTrackName: "agent-voice",
    })
    const result = normalizeAgentParticipantMedia(
      pending,
      grantedVoice(),
      AGENT_ID
    )
    expect(result.changed).toBe(false)
    expect(result.media?.tracks).toEqual([])
    expect(result.media?.agentPublishedMid).toBe(MID)
    expect(result.media?.agentPublishedTrackName).toBe("agent-voice")
  })

  it("strips tracks when the grant names a different agent", () => {
    const other = { ...grantedVoice(), agentParticipantId: "agent-other" }
    const result = normalizeAgentParticipantMedia(media(), other, AGENT_ID)
    expect(result.changed).toBe(true)
    expect(result.media?.tracks).toEqual([])
    expect(result.media?.agentPublishedMid).toBeUndefined()
  })

  it("strips multi-track or video shapes even under an active grant", () => {
    const two = media({
      tracks: [
        { trackName: "a", kind: "audio" },
        { trackName: "b", kind: "audio" },
      ],
    })
    expect(
      normalizeAgentParticipantMedia(two, grantedVoice(), AGENT_ID).changed
    ).toBe(true)

    const video = media({
      tracks: [{ trackName: "v", kind: "video" }],
    })
    const videoResult = normalizeAgentParticipantMedia(
      video,
      grantedVoice(),
      AGENT_ID
    )
    expect(videoResult.changed).toBe(true)
    expect(videoResult.media?.agentPublishedMid).toBeUndefined()
  })

  it("strips a mid without a matching track (illegal state)", () => {
    const orphan = media({ tracks: [] })
    const result = normalizeAgentParticipantMedia(
      orphan,
      grantedVoice(),
      AGENT_ID
    )
    expect(result.changed).toBe(true)
    expect(result.media?.agentPublishedMid).toBeUndefined()
  })

  it("leaves absent media untouched", () => {
    const result = normalizeAgentParticipantMedia(
      undefined,
      grantedVoice(),
      AGENT_ID
    )
    expect(result.changed).toBe(false)
    expect(result.media).toBeUndefined()
  })

  it("end-to-end: publish writes mid+track, reload keeps them, Stop clears them", () => {
    // Simulate agent-track-published bookkeeping.
    const stored = media()
    // Reload #1: normalization must preserve the live publication.
    const afterLoad = normalizeAgentParticipantMedia(
      stored,
      grantedVoice(),
      AGENT_ID
    )
    expect(afterLoad.changed).toBe(false)
    // Human resync sees the voice track and can subscribe.
    expect(
      afterLoad.media?.tracks.some((t) => t.trackName === "agent-voice")
    ).toBe(true)
    // Stop flips the grant off; next load clears the dead publication.
    const stopped = { ...grantedVoice(), active: false }
    const afterStop = normalizeAgentParticipantMedia(
      afterLoad.media,
      stopped,
      AGENT_ID
    )
    expect(afterStop.changed).toBe(true)
    expect(afterStop.media?.tracks).toEqual([])
  })
})

describe("normalizeRoom ordering: invalid grants degrade BEFORE media preservation (#130 P1)", () => {
  const rawInvalidGrant = {
    active: true,
    agentParticipantId: AGENT_ID,
    // startedAt MISSING — persisted state from an older writer.
  }
  const rawInvalidStartedAt = {
    active: true,
    agentParticipantId: AGENT_ID,
    startedAt: "not-a-number",
  }

  it("isValidVoiceReplyState rejects both malformed raw grants", () => {
    expect(isValidVoiceReplyState(rawInvalidGrant)).toBe(false)
    expect(isValidVoiceReplyState(rawInvalidStartedAt)).toBe(false)
  })

  it("missing startedAt clears tracks and mid instead of preserving them", () => {
    const normalized = isValidVoiceReplyState(rawInvalidGrant)
      ? rawInvalidGrant
      : NO_VOICE_REPLY
    const result = normalizeAgentParticipantMedia(media(), normalized, AGENT_ID)
    expect(result.changed).toBe(true)
    expect(result.media?.tracks).toEqual([])
    expect(result.media?.agentPublishedMid).toBeUndefined()
  })

  it("non-numeric startedAt clears tracks and mid instead of preserving them", () => {
    const normalized = isValidVoiceReplyState(rawInvalidStartedAt)
      ? rawInvalidStartedAt
      : NO_VOICE_REPLY
    const result = normalizeAgentParticipantMedia(media(), normalized, AGENT_ID)
    expect(result.changed).toBe(true)
    expect(result.media?.tracks).toEqual([])
    expect(result.media?.agentPublishedMid).toBeUndefined()
  })
})
