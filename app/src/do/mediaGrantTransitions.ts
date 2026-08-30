import {
  clearGrantIfParticipantDeparting,
  isAgentAuthorizedForMedia,
  isAgentAuthorizedForVoice,
  NO_MEETING_NOTES,
  startMeetingNotes,
} from "./meetingNotesAuth"
import {
  MAX_PENDING_CLEANUP_ENTRIES,
  pendingCleanupHasCapacity,
  type AgentMediaRevocationDirection,
} from "./realtimeMedia"
import {
  runtimeHostForParticipant,
  runtimeHostParticipantIds,
} from "./runtimeHost"
import type {
  AgentVoiceState,
  MeetingNotesState,
  PendingMediaCleanup,
  RoomParticipant,
  RuntimeHostProjection,
} from "../room/types"

// Pure Room-grant decisions for the two independent Agent media directions:
//
// - Meeting Notes authorizes Human -> Agent subscriptions.
// - Agent Voice authorizes Agent -> Human publications.
//
// The transitions below deliberately return intent only. RoomSession remains
// the one place that stages cleanup, persists RoomRecord, broadcasts, and
// performs the existing after-persist Cloudflare close/retry flow.
export interface AgentMediaRevocationIntent {
  participantId: string
  direction: AgentMediaRevocationDirection
}

export interface NormalizedMediaGrants {
  meetingNotes: MeetingNotesState
  agentVoice: AgentVoiceState
  changed: boolean
}

export function normalizeMediaGrants(args: {
  meetingNotes: unknown
  agentVoice: unknown
  participants: Record<string, RoomParticipant>
  runtimeHosts: Record<string, RuntimeHostProjection>
}): NormalizedMediaGrants {
  let changed = false
  const meetingNotes = normalizeMeetingNotesGrant(
    args.meetingNotes,
    args.participants
  )
  if (meetingNotes.changed) changed = true
  const agentVoice = normalizeAgentVoiceGrants(
    args.agentVoice,
    args.participants,
    args.runtimeHosts
  )
  if (agentVoice.changed) changed = true
  return {
    meetingNotes: meetingNotes.meetingNotes,
    agentVoice: agentVoice.agentVoice,
    changed,
  }
}

function normalizeMeetingNotesGrant(
  value: unknown,
  participants: Record<string, RoomParticipant>
): { meetingNotes: MeetingNotesState; changed: boolean } {
  if (!isMeetingNotesState(value))
    return { meetingNotes: NO_MEETING_NOTES, changed: true }
  if (
    value.active &&
    (!value.agentParticipantId ||
      participants[value.agentParticipantId]?.kind !== "agent")
  )
    return { meetingNotes: NO_MEETING_NOTES, changed: true }
  return { meetingNotes: value, changed: false }
}

function isMeetingNotesState(value: unknown): value is MeetingNotesState {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<MeetingNotesState>
  if (typeof candidate.active !== "boolean") return false
  if (!candidate.active) return true
  return (
    typeof candidate.agentParticipantId === "string" &&
    candidate.agentParticipantId.length > 0 &&
    typeof candidate.startedAt === "number"
  )
}

export function normalizeAgentVoiceGrants(
  value: unknown,
  participants: Record<string, RoomParticipant>,
  runtimeHosts: Record<string, RuntimeHostProjection>
): { agentVoice: AgentVoiceState; changed: boolean } {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  let changed = raw !== value
  const agentVoice: AgentVoiceState = {}
  for (const [participantId, rawGrant] of Object.entries(raw)) {
    const participant = participants[participantId]
    const host = participant
      ? runtimeHostForParticipant(runtimeHosts, participant)
      : undefined
    const grant = rawGrant as Partial<AgentVoiceState[string]> | null
    const valid =
      participant?.kind === "agent" &&
      participant.connected &&
      host?.speech.tts === true &&
      Boolean(grant) &&
      grant?.enabled === true &&
      typeof grant.enabledAt === "number" &&
      Number.isFinite(grant.enabledAt) &&
      grant.enabledAt > 0
    if (!valid) {
      changed = true
      continue
    }
    agentVoice[participantId] = {
      enabled: true,
      enabledAt: grant.enabledAt!,
    }
  }
  return { agentVoice, changed }
}

/**
 * Storage hygiene for an Agent's visible outbound Voice state. This is only
 * a persisted-state repair; revocation execution stays in RoomSession's
 * existing durable stage -> persist -> cleanup flow.
 */
export function normalizeAgentVoiceParticipantMedia(
  media: RoomParticipant["media"],
  agentVoice: AgentVoiceState,
  participantId: string
): { media: RoomParticipant["media"]; changed: boolean } {
  if (!media) return { media, changed: false }
  const tracks = Array.isArray(media.tracks) ? media.tracks : []
  const publishedMid =
    typeof media.agentPublishedMid === "string" &&
    media.agentPublishedMid.length > 0
      ? media.agentPublishedMid
      : undefined
  const pendingTrackName =
    typeof media.agentPublishedTrackName === "string" &&
    media.agentPublishedTrackName.length > 0
      ? media.agentPublishedTrackName
      : undefined
  const authorized =
    isAgentAuthorizedForVoice(agentVoice, participantId) &&
    publishedMid !== undefined &&
    ((tracks.length === 1 && tracks[0]!.kind === "audio") ||
      (tracks.length === 0 && pendingTrackName !== undefined))
  if (authorized) return { media, changed: false }
  if (
    tracks.length === 0 &&
    publishedMid === undefined &&
    pendingTrackName === undefined
  )
    return { media, changed: false }
  const next: RoomParticipant["media"] = { ...media, tracks: [] }
  if (publishedMid !== undefined) delete next.agentPublishedMid
  if (pendingTrackName !== undefined) delete next.agentPublishedTrackName
  delete next.agentVoiceReady
  return { media: next, changed: true }
}

export type AgentVoiceSetTransition =
  | {
      ok: true
      agentVoice: AgentVoiceState
      revocations: AgentMediaRevocationIntent[]
    }
  | { ok: false; error: "voice_unavailable" | "agent_media_cleanup_backlog" }

export function transitionAgentVoiceSet(args: {
  agentVoice: AgentVoiceState
  participants: Record<string, RoomParticipant>
  runtimeHosts: Record<string, RuntimeHostProjection> | undefined
  pendingMediaCleanup: PendingMediaCleanup[]
  agentMediaEnabled: boolean
  agentParticipantId: string
  enabled: boolean
  now: number
}): AgentVoiceSetTransition {
  const agent = args.participants[args.agentParticipantId]
  if (args.enabled) {
    const host = agent
      ? runtimeHostForParticipant(args.runtimeHosts, agent)
      : undefined
    if (
      !args.agentMediaEnabled ||
      !agent ||
      agent.kind !== "agent" ||
      !agent.connected ||
      host?.speech.tts !== true
    )
      return { ok: false, error: "voice_unavailable" }

    // Replays preserve the existing authorization epoch and do not restart
    // a Runtime publication.
    if (isAgentAuthorizedForVoice(args.agentVoice, agent.id))
      return { ok: true, agentVoice: args.agentVoice, revocations: [] }

    if (
      !pendingCleanupHasCapacity(
        args.pendingMediaCleanup,
        agent.media?.sessionId ?? "",
        1
      )
    )
      return { ok: false, error: "agent_media_cleanup_backlog" }

    return {
      ok: true,
      agentVoice: {
        ...args.agentVoice,
        [agent.id]: { enabled: true, enabledAt: args.now },
      },
      revocations: [],
    }
  }

  if (!args.agentVoice[args.agentParticipantId])
    return { ok: true, agentVoice: args.agentVoice, revocations: [] }
  const agentVoice = { ...args.agentVoice }
  delete agentVoice[args.agentParticipantId]
  return {
    ok: true,
    agentVoice,
    // Voice Stop affects only Agent -> Human publication. A Meeting Notes
    // Human -> Agent subscription can be independently active for this Agent.
    revocations: [
      { participantId: args.agentParticipantId, direction: "published" },
    ],
  }
}

export function transitionAgentVoiceForRuntimeHostUpdate(args: {
  agentVoice: AgentVoiceState
  participants: Iterable<RoomParticipant>
  participant: RoomParticipant
  currentHost: RuntimeHostProjection
  previousHostId?: string
  previousProjection?: RuntimeHostProjection
}): {
  agentVoice: AgentVoiceState
  revocations: AgentMediaRevocationIntent[]
} {
  const participantList = Array.from(args.participants)
  const revokeIds = new Set<string>()
  const revoke = (participantId: string) => {
    if (args.agentVoice[participantId]) revokeIds.add(participantId)
  }

  // Moving an Agent to any different Runtime Host cannot carry its old Voice
  // authorization across the host boundary.
  if (
    args.previousHostId &&
    args.previousHostId !== args.currentHost.runtimeHostId
  )
    revoke(args.participant.id)

  // A true -> false TTS transition applies to every Agent using the shared
  // host projection. Recovery deliberately has no symmetric re-grant path.
  if (
    args.previousProjection?.speech.tts === true &&
    args.currentHost.speech.tts === false
  )
    for (const participantId of runtimeHostParticipantIds(
      participantList,
      args.currentHost.runtimeHostId,
      args.participant.id
    ))
      revoke(participantId)

  if (revokeIds.size === 0)
    return { agentVoice: args.agentVoice, revocations: [] }
  const agentVoice = { ...args.agentVoice }
  for (const participantId of revokeIds) delete agentVoice[participantId]
  return {
    agentVoice,
    revocations: [...revokeIds].map((participantId) => ({
      participantId,
      direction: "published",
    })),
  }
}

export type MeetingNotesStartTransition =
  | {
      ok: true
      meetingNotes: MeetingNotesState
      revocations: AgentMediaRevocationIntent[]
      idempotent: boolean
    }
  | {
      ok: false
      error:
        | "meeting_notes_media_disabled"
        | "agent_not_in_room"
        | "agent_media_cleanup_backlog"
    }

export function transitionMeetingNotesStart(args: {
  meetingNotes: MeetingNotesState
  participants: Record<string, RoomParticipant>
  pendingMediaCleanup: PendingMediaCleanup[]
  agentMediaEnabled: boolean
  agentParticipantId: string
  now: number
}): MeetingNotesStartTransition {
  if (!args.agentMediaEnabled)
    return { ok: false, error: "meeting_notes_media_disabled" }
  const agent = args.participants[args.agentParticipantId]
  if (!agent || agent.kind !== "agent" || !agent.connected)
    return { ok: false, error: "agent_not_in_room" }
  if (isAgentAuthorizedForMedia(args.meetingNotes, agent.id))
    return {
      ok: true,
      meetingNotes: args.meetingNotes,
      revocations: [],
      idempotent: true,
    }
  if (args.pendingMediaCleanup.length >= MAX_PENDING_CLEANUP_ENTRIES)
    return { ok: false, error: "agent_media_cleanup_backlog" }

  const previousAgentId = args.meetingNotes.agentParticipantId
  return {
    ok: true,
    meetingNotes: startMeetingNotes(agent.id, args.now),
    // Reassignment closes only the prior Human -> Agent subscriptions. Its
    // independent Agent Voice publication remains authorized and visible.
    revocations:
      previousAgentId && previousAgentId !== agent.id
        ? [{ participantId: previousAgentId, direction: "subscribed" }]
        : [],
    idempotent: false,
  }
}

export function transitionMeetingNotesStop(meetingNotes: MeetingNotesState): {
  meetingNotes: MeetingNotesState
  revocations: AgentMediaRevocationIntent[]
} {
  const previousAgentId = meetingNotes.agentParticipantId
  return {
    meetingNotes: NO_MEETING_NOTES,
    revocations: previousAgentId
      ? [{ participantId: previousAgentId, direction: "subscribed" }]
      : [],
  }
}

export function transitionMediaGrantsForParticipantDeparture(args: {
  meetingNotes: MeetingNotesState
  agentVoice: AgentVoiceState
  participant: RoomParticipant
}): {
  meetingNotes: MeetingNotesState
  agentVoice: AgentVoiceState
  revocations: AgentMediaRevocationIntent[]
} {
  const agentVoice = args.agentVoice[args.participant.id]
    ? { ...args.agentVoice }
    : args.agentVoice
  if (agentVoice !== args.agentVoice) delete agentVoice[args.participant.id]
  return {
    meetingNotes: clearGrantIfParticipantDeparting(
      args.meetingNotes,
      args.participant.id
    ),
    agentVoice,
    // Participant teardown remains the one intentionally broad case: an
    // Agent may own both independent media directions, and neither may outlive
    // its Room participant/lease.
    revocations:
      args.participant.kind === "agent"
        ? [{ participantId: args.participant.id, direction: "both" }]
        : [],
  }
}
