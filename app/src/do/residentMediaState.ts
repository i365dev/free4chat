import type {
  AgentVoiceState,
  LiveTranscriptState,
  MeetingNotesState,
  ResidentMediaState,
} from "../room/types"

interface ResidentMediaStateInput {
  participantId: string
  meetingNotes: MeetingNotesState
  agentVoice: AgentVoiceState
  liveTranscript: LiveTranscriptState
  mediaAvailable: boolean
}

// Projects only the media state that the named resident needs to reconcile its
// own controller. In particular, do not expose another Agent's grant or the
// Human that started Live Transcript through this private event envelope.
export function projectResidentMediaState({
  participantId,
  meetingNotes,
  agentVoice,
  liveTranscript,
  mediaAvailable,
}: ResidentMediaStateInput): ResidentMediaState {
  const meetingNotesForSelf =
    meetingNotes.active && meetingNotes.agentParticipantId === participantId
  const meetingNotesState = meetingNotesForSelf
    ? {
        active: true as const,
        ...(meetingNotes.startedAt !== undefined
          ? { startedAt: meetingNotes.startedAt }
          : {}),
      }
    : { active: false as const }

  const voiceGrant = agentVoice[participantId]
  const agentVoiceEnabledAt =
    voiceGrant?.enabled && voiceGrant.enabledAt > 0
      ? voiceGrant.enabledAt
      : undefined

  const liveTranscriptState: ResidentMediaState["liveTranscript"] =
    liveTranscript.active
      ? {
          active: true,
          producerRuntimeHostId: liveTranscript.producerRuntimeHostId,
          epoch: liveTranscript.epoch,
        }
      : { active: false }

  return {
    meetingNotes: meetingNotesState,
    ...(agentVoiceEnabledAt === undefined ? {} : { agentVoiceEnabledAt }),
    mediaAvailable,
    liveTranscript: liveTranscriptState,
  }
}
