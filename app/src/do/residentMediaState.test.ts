import { describe, expect, it } from "vitest"

import { projectResidentMediaState } from "./residentMediaState"

describe("projectResidentMediaState", () => {
  it("projects only the named resident's media authorization", () => {
    const state = projectResidentMediaState({
      participantId: "agent-a",
      meetingNotes: {
        active: true,
        agentParticipantId: "agent-a",
        startedAt: 11,
      },
      agentVoice: {
        "agent-a": { enabled: true, enabledAt: 22 },
        "agent-b": { enabled: true, enabledAt: 33 },
      },
      liveTranscript: {
        active: true,
        producerRuntimeHostId: "host-a",
        startedByHumanParticipantId: "human-a",
        epoch: 7,
        startedAt: 8,
      },
      mediaAvailable: true,
    })

    expect(state).toEqual({
      meetingNotes: { active: true, startedAt: 11 },
      agentVoiceEnabledAt: 22,
      mediaAvailable: true,
      liveTranscript: {
        active: true,
        producerRuntimeHostId: "host-a",
        epoch: 7,
      },
    })
    expect(state).not.toHaveProperty("startedByHumanParticipantId")
  })

  it("does not leak another Agent's grant to a different resident", () => {
    const state = projectResidentMediaState({
      participantId: "agent-b",
      meetingNotes: {
        active: true,
        agentParticipantId: "agent-a",
        startedAt: 11,
      },
      agentVoice: {
        "agent-a": { enabled: true, enabledAt: 22 },
      },
      liveTranscript: { active: false },
      mediaAvailable: false,
    })

    expect(state).toEqual({
      meetingNotes: { active: false },
      mediaAvailable: false,
      liveTranscript: { active: false },
    })
  })
})
