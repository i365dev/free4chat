import { describe, expect, it } from "vitest"

import {
  normalizeAgentVoiceParticipantMedia,
  normalizeMediaGrants,
  transitionAgentVoiceForRuntimeHostUpdate,
  transitionAgentVoiceSet,
  transitionMediaGrantsForParticipantDeparture,
  transitionMeetingNotesStart,
  transitionMeetingNotesStop,
} from "./mediaGrantTransitions"
import { NO_MEETING_NOTES, startMeetingNotes } from "./meetingNotesAuth"
import type {
  AgentVoiceState,
  PendingMediaCleanup,
  RoomParticipant,
  RuntimeHostProjection,
} from "../room/types"

const HOST_A: RuntimeHostProjection = {
  runtimeHostId: "host-a",
  speech: { stt: false, tts: true },
}
const HOST_B: RuntimeHostProjection = {
  runtimeHostId: "host-b",
  speech: { stt: false, tts: true },
}
const HOST_UNREADY: RuntimeHostProjection = {
  runtimeHostId: "host-a",
  speech: { stt: false, tts: false },
}

function agent(
  id: string,
  runtimeHostId = HOST_A.runtimeHostId,
  connected = true
): RoomParticipant {
  return {
    id,
    name: id,
    kind: "agent",
    connected,
    joinedAt: 1,
    lastSeenAt: 1,
    token: `${id}-token`,
    runtimeHostId,
  }
}

function human(id = "human"): RoomParticipant {
  return {
    id,
    name: id,
    kind: "human",
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: `${id}-token`,
  }
}

function participantMap(...members: RoomParticipant[]) {
  return Object.fromEntries(members.map((member) => [member.id, member]))
}

function enabledVoice(...ids: string[]): AgentVoiceState {
  return Object.fromEntries(
    ids.map((id) => [id, { enabled: true as const, enabledAt: 100 }])
  )
}

const cleanupAtCapacity: PendingMediaCleanup[] = Array.from(
  { length: 16 },
  (_, index) => ({ sessionId: `session-${index}`, mids: ["mid"] })
)

describe("Agent Voice grant transitions", () => {
  it("enables a ready Agent, preserves its epoch on replay, and rejects unavailable or backpressured admission", () => {
    const participants = participantMap(
      agent("pi"),
      agent("offline", "host-a", false)
    )
    const runtimeHosts = { [HOST_A.runtimeHostId]: HOST_A }
    const enabled = transitionAgentVoiceSet({
      agentVoice: {},
      participants,
      runtimeHosts,
      pendingMediaCleanup: [],
      agentMediaEnabled: true,
      agentParticipantId: "pi",
      enabled: true,
      now: 123,
    })
    expect(enabled).toEqual({
      ok: true,
      agentVoice: { pi: { enabled: true, enabledAt: 123 } },
      revocations: [],
    })
    if (!enabled.ok) throw new Error("expected an enabled voice grant")

    expect(
      transitionAgentVoiceSet({
        agentVoice: enabled.agentVoice,
        participants,
        runtimeHosts,
        pendingMediaCleanup: cleanupAtCapacity,
        agentMediaEnabled: true,
        agentParticipantId: "pi",
        enabled: true,
        now: 456,
      })
    ).toEqual({ ok: true, agentVoice: enabled.agentVoice, revocations: [] })
    expect(
      transitionAgentVoiceSet({
        agentVoice: {},
        participants,
        runtimeHosts,
        pendingMediaCleanup: [],
        agentMediaEnabled: true,
        agentParticipantId: "offline",
        enabled: true,
        now: 123,
      })
    ).toEqual({ ok: false, error: "voice_unavailable" })
    expect(
      transitionAgentVoiceSet({
        agentVoice: {},
        participants,
        runtimeHosts,
        pendingMediaCleanup: cleanupAtCapacity,
        agentMediaEnabled: true,
        agentParticipantId: "pi",
        enabled: true,
        now: 123,
      })
    ).toEqual({ ok: false, error: "agent_media_cleanup_backlog" })
  })

  it("disables only the Agent -> Human publication", () => {
    const transition = transitionAgentVoiceSet({
      agentVoice: enabledVoice("pi", "hermes"),
      participants: participantMap(agent("pi"), agent("hermes")),
      runtimeHosts: { [HOST_A.runtimeHostId]: HOST_A },
      pendingMediaCleanup: [],
      agentMediaEnabled: true,
      agentParticipantId: "pi",
      enabled: false,
      now: 123,
    })
    expect(transition).toEqual({
      ok: true,
      agentVoice: enabledVoice("hermes"),
      revocations: [{ participantId: "pi", direction: "published" }],
    })
  })

  it("revokes all same-host grants on a TTS readiness loss but never re-grants on recovery", () => {
    const participants = [
      agent("pi"),
      agent("codex"),
      agent("hermes", "host-b"),
    ]
    const voice = enabledVoice("pi", "codex", "hermes")
    const loss = transitionAgentVoiceForRuntimeHostUpdate({
      agentVoice: voice,
      participants,
      participant: participants[0]!,
      currentHost: HOST_UNREADY,
      previousHostId: HOST_A.runtimeHostId,
      previousProjection: HOST_A,
    })
    expect(loss).toEqual({
      agentVoice: enabledVoice("hermes"),
      revocations: [
        { participantId: "pi", direction: "published" },
        { participantId: "codex", direction: "published" },
      ],
    })
    expect(
      transitionAgentVoiceForRuntimeHostUpdate({
        agentVoice: loss.agentVoice,
        participants,
        participant: participants[0]!,
        currentHost: HOST_A,
        previousHostId: HOST_A.runtimeHostId,
        previousProjection: HOST_UNREADY,
      })
    ).toEqual({ agentVoice: enabledVoice("hermes"), revocations: [] })
  })

  it("revokes only the moved Agent on a Runtime Host switch", () => {
    expect(
      transitionAgentVoiceForRuntimeHostUpdate({
        agentVoice: enabledVoice("pi", "codex"),
        participants: [agent("pi"), agent("codex")],
        participant: agent("pi"),
        currentHost: HOST_B,
        previousHostId: HOST_A.runtimeHostId,
        previousProjection: HOST_A,
      })
    ).toEqual({
      agentVoice: enabledVoice("codex"),
      revocations: [{ participantId: "pi", direction: "published" }],
    })
  })
})

describe("Meeting Notes and participant departure transitions", () => {
  it("keeps the current grant epoch on replay and rejects new work at cleanup capacity", () => {
    const current = startMeetingNotes("pi", 100)
    const participants = participantMap(agent("pi"), agent("codex"))
    expect(
      transitionMeetingNotesStart({
        meetingNotes: current,
        participants,
        pendingMediaCleanup: cleanupAtCapacity,
        agentMediaEnabled: true,
        agentParticipantId: "pi",
        now: 200,
      })
    ).toEqual({
      ok: true,
      meetingNotes: current,
      revocations: [],
      idempotent: true,
    })
    expect(
      transitionMeetingNotesStart({
        meetingNotes: current,
        participants,
        pendingMediaCleanup: cleanupAtCapacity,
        agentMediaEnabled: true,
        agentParticipantId: "codex",
        now: 200,
      })
    ).toEqual({ ok: false, error: "agent_media_cleanup_backlog" })
  })

  it("reassignment and stop revoke only Human -> Agent subscriptions", () => {
    const reassignment = transitionMeetingNotesStart({
      meetingNotes: startMeetingNotes("pi", 100),
      participants: participantMap(agent("pi"), agent("codex")),
      pendingMediaCleanup: [],
      agentMediaEnabled: true,
      agentParticipantId: "codex",
      now: 200,
    })
    expect(reassignment).toEqual({
      ok: true,
      meetingNotes: startMeetingNotes("codex", 200),
      revocations: [{ participantId: "pi", direction: "subscribed" }],
      idempotent: false,
    })
    expect(transitionMeetingNotesStop(startMeetingNotes("codex", 200))).toEqual(
      {
        meetingNotes: NO_MEETING_NOTES,
        revocations: [{ participantId: "codex", direction: "subscribed" }],
      }
    )
  })

  it("clears both independent grants when an Agent departs, but leaves unrelated grants on Human departure", () => {
    const notes = startMeetingNotes("pi", 100)
    const voice = enabledVoice("pi", "codex")
    expect(
      transitionMediaGrantsForParticipantDeparture({
        meetingNotes: notes,
        agentVoice: voice,
        participant: agent("pi"),
      })
    ).toEqual({
      meetingNotes: NO_MEETING_NOTES,
      agentVoice: enabledVoice("codex"),
      revocations: [{ participantId: "pi", direction: "both" }],
    })
    expect(
      transitionMediaGrantsForParticipantDeparture({
        meetingNotes: notes,
        agentVoice: voice,
        participant: human(),
      })
    ).toEqual({
      meetingNotes: notes,
      agentVoice: voice,
      revocations: [],
    })
  })
})

describe("stored grant normalization", () => {
  it("drops invalid Agent Voice authorization and scrubs its stale visible media", () => {
    const pi = agent("pi")
    pi.media = {
      sessionId: "pi-session",
      muted: true,
      fileChannelReady: false,
      tracks: [{ trackName: "agent-voice", kind: "audio" }],
      agentPublishedMid: "published-mid",
      agentPublishedTrackName: "agent-voice",
    }
    const participants = participantMap(pi)
    const grants = normalizeMediaGrants({
      meetingNotes: {
        active: true,
        agentParticipantId: "missing",
        startedAt: 1,
      },
      agentVoice: { pi: { enabled: true, enabledAt: "not-a-number" } },
      participants,
      runtimeHosts: { [HOST_A.runtimeHostId]: HOST_A },
    })
    expect(grants).toEqual({
      meetingNotes: NO_MEETING_NOTES,
      agentVoice: {},
      changed: true,
    })
    expect(
      normalizeAgentVoiceParticipantMedia(pi.media, grants.agentVoice, pi.id)
    ).toEqual({
      media: {
        sessionId: "pi-session",
        muted: true,
        fileChannelReady: false,
        tracks: [],
      },
      changed: true,
    })
  })
})
