export type {
  MeetingNotesState as SfuMeetingNotesState,
  VoiceReplyState as SfuVoiceReplyState,
  ParticipantKind,
  RoomMessage as SfuMessage,
  RoomParticipant as SfuParticipant,
  RoomRecord as SfuRoomRecord,
  RoomState as SfuRoomState,
  RoomMediaTrack as SfuTrack,
} from "../room/types"

export type SfuTrackKind = "audio" | "video"

export interface SfuPublishedTrackParticipant {
  id: string
  name: string
  kind: import("../room/types").ParticipantKind
  sessionId: string
  track: import("../room/types").RoomMediaTrack
}

export interface SfuSessionResponse {
  participantId: string
  participantToken: string
  sessionId: string
  expiresAt: number
}
