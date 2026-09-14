import { useEffect, useRef } from "react"

import { LOCAL_PEER_ID } from "@common/consts"
import type { UserInfo } from "@common/types"

/**
 * Room-level remote audio playback.
 *
 * Voice is Room ambient state, not a Stage surface: opening, hiding or
 * fullscreening a Room App (or watching a screen share / Live View) only
 * changes what the Stage shows, and must never remove the audio sink that is
 * actually playing another participant.
 *
 * These sinks therefore live for the whole Room session, one element per
 * non-local participant, keyed by the participant id the roster already owns.
 * They are deliberately NOT rendered by `UserCard`: the participant card is a
 * visual surface whose lifetime follows the Stage layout, so playback used to
 * stop whenever the participant grid was replaced by a Room App. The card
 * keeps the mute control, the avatar and the audio visualizer; this component
 * is the single audible playback owner for remote voice.
 *
 * Local self-audio is never rendered: the browser's own microphone is already
 * audible in the room and playing it locally would create a feedback loop.
 */
interface RoomAudioSinkProps {
  peerId: string
  stream: MediaStream | null
}

function RoomAudioSink({ peerId, stream }: RoomAudioSinkProps) {
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const element = audioRef.current
    if (!element) return
    element.srcObject = stream
    return () => {
      // Release the stream when this sink really goes away: the participant
      // left, media was replaced, or the Room session ended. Never on a pure
      // Stage/visibility change — that no longer unmounts this component.
      if (element.srcObject === stream) element.srcObject = null
    }
  }, [stream])

  return (
    <audio
      ref={audioRef}
      autoPlay
      data-testid="room-audio-sink"
      data-peer-id={peerId}
      hidden
    />
  )
}

interface RoomAudioSinksProps {
  participants: Pick<UserInfo, "peerId" | "audioStream">[]
}

/**
 * Persistent playback surface for every remote participant in the Room.
 *
 * Element identity follows the participant, not the stream: a media reconnect
 * that hands the participant a new `MediaStream` swaps `srcObject` on the same
 * element instead of destroying and recreating the sink.
 */
export default function RoomAudioSinks({ participants }: RoomAudioSinksProps) {
  return (
    <div data-testid="room-audio-sinks" hidden aria-hidden="true">
      {participants
        .filter((participant) => participant.peerId !== LOCAL_PEER_ID)
        .map((participant) => (
          <RoomAudioSink
            key={participant.peerId}
            peerId={participant.peerId}
            stream={participant.audioStream ?? null}
          />
        ))}
    </div>
  )
}
