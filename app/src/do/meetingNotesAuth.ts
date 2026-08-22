import type { MeetingNotesState } from "../room/types"

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
