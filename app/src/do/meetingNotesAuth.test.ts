import { describe, expect, it } from "vitest"

import {
  clearGrantIfParticipantDeparting,
  isAgentAuthorizedForMedia,
  NO_MEETING_NOTES,
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
