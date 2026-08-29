import { describe, expect, it } from "vitest"

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

function enabledVoice(participantId = AGENT_ID) {
  return { [participantId]: { enabled: true as const, enabledAt: 1000 } }
}

describe("normalizeAgentParticipantMedia", () => {
  it("preserves only the enabled Agent's single published audio track", () => {
    const result = normalizeAgentParticipantMedia(
      media(),
      enabledVoice(),
      AGENT_ID
    )
    expect(result.changed).toBe(false)
    expect(result.media?.agentPublishedMid).toBe(MID)
  })

  it("strips a muted Agent's prior publication on reload", () => {
    const result = normalizeAgentParticipantMedia(media(), {}, AGENT_ID)
    expect(result.changed).toBe(true)
    expect(result.media?.tracks).toEqual([])
    expect(result.media?.agentPublishedMid).toBeUndefined()
  })

  it("does not transfer authorization to another participant", () => {
    const result = normalizeAgentParticipantMedia(
      media(),
      enabledVoice("agent-other"),
      AGENT_ID
    )
    expect(result.changed).toBe(true)
    expect(result.media?.agentPublishedMid).toBeUndefined()
  })

  it("continues to reject malformed multi-track or video publications", () => {
    expect(
      normalizeAgentParticipantMedia(
        media({
          tracks: [
            { trackName: "a", kind: "audio" },
            { trackName: "b", kind: "audio" },
          ],
        }),
        enabledVoice(),
        AGENT_ID
      ).changed
    ).toBe(true)
    expect(
      normalizeAgentParticipantMedia(
        media({ tracks: [{ trackName: "v", kind: "video" }] }),
        enabledVoice(),
        AGENT_ID
      ).changed
    ).toBe(true)
  })
})
