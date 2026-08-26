import type {
  AgentMediaPermissions,
  MeetingNotesState,
  VoiceReplyState,
} from "../room/types"

export const NO_MEETING_NOTES: MeetingNotesState = { active: false }

/**
 * The core Meeting Notes authorization decision (#82): may this specific
 * agent participant currently obtain room Human media? Holding a valid
 * agent participant token is necessary but never sufficient on its own —
 * there must also be an active grant naming exactly this agent.
 */
export function isAgentAuthorizedForMedia(
  meetingNotes: MeetingNotesState,
  agentParticipantId: string
): boolean {
  return (
    meetingNotes.active &&
    meetingNotes.agentParticipantId === agentParticipantId
  )
}

/**
 * Called whenever a participant leaves or expires. If they were the
 * selected note-taker, the grant must not silently keep authorizing media
 * for a participant that's no longer in the room — returns the room back
 * to NO_MEETING_NOTES. Returns the *same* MeetingNotesState reference when
 * nothing changes, so callers can cheaply tell whether they need to persist
 * anything.
 */
export function clearGrantIfParticipantDeparting(
  meetingNotes: MeetingNotesState,
  departingParticipantId: string
): MeetingNotesState {
  if (meetingNotes.agentParticipantId !== departingParticipantId)
    return meetingNotes
  return NO_MEETING_NOTES
}

/** Starts a fresh grant naming this agent as the note-taker. */
export function startMeetingNotes(
  agentParticipantId: string,
  now: number
): MeetingNotesState {
  return { active: true, agentParticipantId, startedAt: now }
}

export const NO_VOICE_REPLY: VoiceReplyState = { active: false }

/** #83: may this connected resident Agent publish its single voice track? */
export function isAgentAuthorizedForVoiceReply(
  voiceReply: VoiceReplyState,
  agentParticipantId: string
): boolean {
  return (
    voiceReply.active && voiceReply.agentParticipantId === agentParticipantId
  )
}

/**
 * #83 review: the ONE shared Agent SFU session (transport, attach) may be
 * admitted when EITHER independent grant names this agent — a VR-only room
 * must be able to build its outbound transport exactly like an MN-only one.
 * This admits transport/session plumbing only: it never exposes Human audio
 * (agent-room-media discovery stays Meeting-Notes-only) and never permits
 * publish (that stays voiceReply-only).
 */
export function isAgentAuthorizedForSharedMedia(
  meetingNotes: MeetingNotesState,
  voiceReply: VoiceReplyState,
  agentParticipantId: string
): boolean {
  return (
    isAgentAuthorizedForMedia(meetingNotes, agentParticipantId) ||
    isAgentAuthorizedForVoiceReply(voiceReply, agentParticipantId)
  )
}

export function startVoiceReply(
  agentParticipantId: string,
  now: number
): VoiceReplyState {
  return { active: true, agentParticipantId, startedAt: now }
}

/** Departure/expiry staleness rule, mirroring Meeting Notes. */
export function clearVoiceReplyIfParticipantDeparting(
  voiceReply: VoiceReplyState,
  departingParticipantId: string
): VoiceReplyState {
  if (voiceReply.agentParticipantId !== departingParticipantId)
    return voiceReply
  return NO_VOICE_REPLY
}

export type AgentMediaPurpose =
  | "meeting-notes"
  | "voice-reply"
  | "agent-transport"

/**
 * #83 direction matrix (pure, fail-closed): what an explicit narrow purpose
 * permits for an Agent media operation. Missing/unknown purpose fails;
 * meeting-notes unlocks ONLY remote Human-audio subscribe; voice-reply
 * unlocks ONLY local single-audio publish; agent-transport covers ONLY
 * transport plumbing (initial DataChannel establish / bootstrap
 * renegotiation) and is refused for any media direction; video is always
 * denied.
 */
export function resolveAgentPurposePermission(args: {
  purpose: unknown
  wantsLocalPublish: boolean
  wantsRemoteSubscribe: boolean
  involvesVideo: boolean
}): { ok: true } | { ok: false; error: string } {
  if (args.involvesVideo) return { ok: false, error: "agent_video_forbidden" }
  if (
    args.purpose !== "meeting-notes" &&
    args.purpose !== "voice-reply" &&
    args.purpose !== "agent-transport"
  )
    return { ok: false, error: "agent_media_purpose_required" }
  if (args.wantsLocalPublish && args.purpose !== "voice-reply")
    return { ok: false, error: "agent_media_direction_forbidden" }
  if (args.wantsRemoteSubscribe && args.purpose !== "meeting-notes")
    return { ok: false, error: "agent_media_direction_forbidden" }
  return { ok: true }
}

/** Booleans-only discovery payload for Agent discovery/session responses. */
export function agentMediaPermissions(
  meetingNotes: MeetingNotesState,
  voiceReply: VoiceReplyState,
  agentParticipantId: string
): AgentMediaPermissions {
  return {
    canSubscribeHumanAudio: isAgentAuthorizedForMedia(
      meetingNotes,
      agentParticipantId
    ),
    canPublishVoice: isAgentAuthorizedForVoiceReply(
      voiceReply,
      agentParticipantId
    ),
  }
}
