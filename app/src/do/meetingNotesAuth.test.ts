import { describe, expect, it } from "vitest"

import {
  clearGrantIfParticipantDeparting,
  isAgentAuthorizedForMedia,
  isAgentAuthorizedForSharedMedia,
  isAgentAuthorizedForVoice,
  NO_MEETING_NOTES,
  resolveAgentPurposePermission,
  startMeetingNotes,
} from "./meetingNotesAuth"

describe("isAgentAuthorizedForMedia", () => {
  it("denies when no Meeting Notes session exists", () => {
    expect(isAgentAuthorizedForMedia(NO_MEETING_NOTES, "agent-a")).toBe(false)
  })

  it("allows the exact agent named by an active grant", () => {
    const state = startMeetingNotes("agent-a", 1000)
    expect(isAgentAuthorizedForMedia(state, "agent-a")).toBe(true)
  })

  it("denies a different agent even while a grant is active for someone else", () => {
    const state = startMeetingNotes("agent-a", 1000)
    expect(isAgentAuthorizedForMedia(state, "agent-b")).toBe(false)
  })

  it("denies the previously-granted agent once the session is stopped", () => {
    const started = startMeetingNotes("agent-a", 1000)
    const stopped = NO_MEETING_NOTES
    expect(isAgentAuthorizedForMedia(started, "agent-a")).toBe(true)
    expect(isAgentAuthorizedForMedia(stopped, "agent-a")).toBe(false)
  })

  it("denies when active is true but agentParticipantId is missing (malformed state)", () => {
    expect(isAgentAuthorizedForMedia({ active: true }, "agent-a")).toBe(false)
  })
})

describe("clearGrantIfParticipantDeparting", () => {
  it("clears the grant when the departing participant is the named agent", () => {
    const state = startMeetingNotes("agent-a", 1000)
    const result = clearGrantIfParticipantDeparting(state, "agent-a")
    expect(result).toEqual(NO_MEETING_NOTES)
  })

  it("leaves an unrelated participant's departure untouched (same reference)", () => {
    const state = startMeetingNotes("agent-a", 1000)
    const result = clearGrantIfParticipantDeparting(state, "human-1")
    expect(result).toBe(state)
  })

  it("is a no-op against an already-inactive grant", () => {
    const result = clearGrantIfParticipantDeparting(NO_MEETING_NOTES, "agent-a")
    expect(result).toBe(NO_MEETING_NOTES)
  })
})

describe("startMeetingNotes", () => {
  it("produces an active grant naming the given agent and timestamp", () => {
    const state = startMeetingNotes("agent-a", 12345)
    expect(state).toEqual({
      active: true,
      agentParticipantId: "agent-a",
      startedAt: 12345,
    })
  })
})

describe("full lifecycle", () => {
  it("start -> authorized -> stop -> denied -> restart for a different agent -> new agent authorized, old agent still denied", () => {
    let state = NO_MEETING_NOTES
    expect(isAgentAuthorizedForMedia(state, "agent-a")).toBe(false)

    state = startMeetingNotes("agent-a", 1000)
    expect(isAgentAuthorizedForMedia(state, "agent-a")).toBe(true)
    expect(isAgentAuthorizedForMedia(state, "agent-b")).toBe(false)

    state = NO_MEETING_NOTES // explicit Stop
    expect(isAgentAuthorizedForMedia(state, "agent-a")).toBe(false)

    state = startMeetingNotes("agent-b", 2000)
    expect(isAgentAuthorizedForMedia(state, "agent-b")).toBe(true)
    expect(isAgentAuthorizedForMedia(state, "agent-a")).toBe(false)
  })

  it("the selected agent leaving mid-session clears the grant, even without an explicit Stop", () => {
    let state = startMeetingNotes("agent-a", 1000)
    expect(isAgentAuthorizedForMedia(state, "agent-a")).toBe(true)

    state = clearGrantIfParticipantDeparting(state, "agent-a")
    expect(isAgentAuthorizedForMedia(state, "agent-a")).toBe(false)
  })
})

describe("isAgentAuthorizedForSharedMedia (#83 review: MN OR VR admission)", () => {
  const mn = (agent?: string) =>
    agent ? startMeetingNotes(agent, 1000) : NO_MEETING_NOTES
  const voice = (agent?: string) =>
    agent ? { [agent]: { enabled: true as const, enabledAt: 1000 } } : {}

  it("admits the shared session under a Meeting Notes grant alone", () => {
    expect(
      isAgentAuthorizedForSharedMedia(mn("agent-a"), voice(), "agent-a")
    ).toBe(true)
  })

  it("admits the shared session under an Agent Voice grant alone", () => {
    expect(
      isAgentAuthorizedForSharedMedia(mn(), voice("agent-a"), "agent-a")
    ).toBe(true)
  })

  it("admits when both grants name the agent", () => {
    expect(
      isAgentAuthorizedForSharedMedia(
        mn("agent-a"),
        voice("agent-a"),
        "agent-a"
      )
    ).toBe(true)
  })

  it("denies when neither grant is active", () => {
    expect(isAgentAuthorizedForSharedMedia(mn(), voice(), "agent-a")).toBe(
      false
    )
  })

  it("denies an agent named by neither grant even while both are active for others", () => {
    expect(
      isAgentAuthorizedForSharedMedia(
        mn("agent-b"),
        voice("agent-c"),
        "agent-a"
      )
    ).toBe(false)
  })

  it("denies once the only authorizing grant stops", () => {
    const notes = startMeetingNotes("agent-a", 1000)
    expect(isAgentAuthorizedForSharedMedia(notes, voice(), "agent-a")).toBe(
      true
    )
    expect(
      isAgentAuthorizedForSharedMedia(NO_MEETING_NOTES, voice(), "agent-a")
    ).toBe(false)
  })
})

describe("resolveAgentPurposePermission — agent-transport purpose", () => {
  it("allows the bare transport bootstrap (no media direction)", () => {
    expect(
      resolveAgentPurposePermission({
        purpose: "agent-transport",
        wantsLocalPublish: false,
        wantsRemoteSubscribe: false,
        involvesVideo: false,
      })
    ).toEqual({ ok: true })
  })

  it("fails closed on a missing or unknown purpose", () => {
    for (const purpose of [undefined, "voice", null]) {
      expect(
        resolveAgentPurposePermission({
          purpose,
          wantsLocalPublish: false,
          wantsRemoteSubscribe: true,
          involvesVideo: false,
        })
      ).toEqual({ ok: false, error: "agent_media_purpose_required" })
    }
  })

  it("refuses any media direction under the transport purpose", () => {
    expect(
      resolveAgentPurposePermission({
        purpose: "agent-transport",
        wantsLocalPublish: true,
        wantsRemoteSubscribe: false,
        involvesVideo: false,
      })
    ).toEqual({ ok: false, error: "agent_media_direction_forbidden" })
    expect(
      resolveAgentPurposePermission({
        purpose: "agent-transport",
        wantsLocalPublish: false,
        wantsRemoteSubscribe: true,
        involvesVideo: false,
      })
    ).toEqual({ ok: false, error: "agent_media_direction_forbidden" })
  })
})

describe("isAgentAuthorizedForVoice", () => {
  it("authorizes only present enabled participant grants", () => {
    const voice = { "agent-a": { enabled: true as const, enabledAt: 1000 } }
    expect(isAgentAuthorizedForVoice(voice, "agent-a")).toBe(true)
    expect(isAgentAuthorizedForVoice(voice, "agent-b")).toBe(false)
    expect(isAgentAuthorizedForVoice({}, "agent-a")).toBe(false)
  })
})
