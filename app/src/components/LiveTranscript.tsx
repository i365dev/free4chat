import { useState } from "react"

import { LOCAL_PEER_ID } from "@common/consts"

import type {
  LiveTranscriptSegment,
  LiveTranscriptState,
  RuntimeHostProjection,
  RuntimeHostProviderPublicAssociation,
} from "../room/types"

interface LiveTranscriptParticipant {
  peerId: string
  name: string
}

interface LiveTranscriptControlProps {
  liveTranscript: LiveTranscriptState
  runtimeHosts?: Record<string, RuntimeHostProjection>
  runtimeHostProviders?: Record<string, RuntimeHostProviderPublicAssociation>
  localParticipantId?: string
  participants: LiveTranscriptParticipant[]
  mediaAvailable: boolean
  onStart: (runtimeHostId: string) => void
  onStop: () => void
}

interface LiveTranscriptSegmentsProps {
  segments: LiveTranscriptSegment[]
}

// Runtime Host ids are discovery identifiers, not authorization. The browser
// may offer Start only when the server's safe RoomState projection explicitly
// associates an STT-ready Host with this authenticated Human participant.
export function authorizedLiveTranscriptHosts({
  runtimeHosts,
  runtimeHostProviders,
  localParticipantId,
}: Pick<
  LiveTranscriptControlProps,
  "runtimeHosts" | "runtimeHostProviders" | "localParticipantId"
>): Array<[string, RuntimeHostProjection]> {
  if (!localParticipantId) return []
  return Object.entries(runtimeHosts ?? {}).filter(
    ([runtimeHostId, host]) =>
      host.speech.stt === true &&
      runtimeHostProviders?.[runtimeHostId]?.humanParticipantId ===
        localParticipantId
  )
}

function providerName({
  liveTranscript,
  participants,
  localParticipantId,
}: Pick<
  LiveTranscriptControlProps,
  "liveTranscript" | "participants" | "localParticipantId"
>): string {
  if (!liveTranscript.active) return ""
  const provider = participants.find(
    (participant) =>
      participant.peerId === liveTranscript.startedByHumanParticipantId ||
      (participant.peerId === LOCAL_PEER_ID &&
        localParticipantId === liveTranscript.startedByHumanParticipantId)
  )
  return provider?.name ?? "a Room participant"
}

export function LiveTranscriptControl({
  liveTranscript = { active: false },
  runtimeHosts,
  runtimeHostProviders,
  localParticipantId,
  participants = [],
  mediaAvailable = false,
  onStart,
  onStop,
}: LiveTranscriptControlProps) {
  const [chooserOpen, setChooserOpen] = useState(false)
  const authorizedHosts = mediaAvailable
    ? authorizedLiveTranscriptHosts({
        runtimeHosts,
        runtimeHostProviders,
        localParticipantId,
      })
    : []

  if (liveTranscript.active) {
    return (
      <div
        className="flex items-center gap-2"
        aria-label="Live Transcript controls"
      >
        <span className="text-xs text-emerald-200">● Live Transcript</span>
        <span className="text-xs text-gray-400">
          Provided by{" "}
          {providerName({
            liveTranscript,
            participants,
            localParticipantId,
          })}
        </span>
        <button
          type="button"
          onClick={onStop}
          className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-1 text-xs text-rose-200 hover:bg-rose-800/50"
          title="Stop Live Transcript for everyone in this room"
        >
          Stop
        </button>
      </div>
    )
  }

  const unavailable = authorizedHosts.length === 0
  return (
    <div
      className="relative flex items-center gap-2"
      aria-label="Live Transcript controls"
    >
      <span className="text-xs text-gray-300">Live Transcript</span>
      <button
        type="button"
        onClick={() => {
          if (authorizedHosts.length === 1) onStart(authorizedHosts[0][0])
          else if (authorizedHosts.length > 1) setChooserOpen((open) => !open)
        }}
        disabled={unavailable}
        className="rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
        title={
          unavailable
            ? "No authorized transcription Runtime is available"
            : "Start Live Transcript"
        }
      >
        Start
      </button>
      {chooserOpen && authorizedHosts.length > 1 && (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-gray-700 bg-gray-800 py-1 shadow-lg">
          <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">
            Choose a Runtime
          </p>
          {authorizedHosts.map(([runtimeHostId], index) => (
            <button
              key={runtimeHostId}
              type="button"
              onClick={() => {
                onStart(runtimeHostId)
                setChooserOpen(false)
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-700"
            >
              Your STT-ready Runtime {index + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function LiveTranscriptSegments({
  segments = [],
}: LiveTranscriptSegmentsProps) {
  if (segments.length === 0) return null
  const ordered = [...segments].sort(
    (left, right) => left.sequence - right.sequence
  )
  return (
    <section
      className="mx-4 mt-1 flex flex-none flex-col rounded border border-emerald-700/40 bg-emerald-950/20 px-4 py-2"
      aria-label="Live Transcript"
    >
      <h2 className="text-sm font-medium text-emerald-100">Live Transcript</h2>
      <ol className="mt-1 max-h-40 space-y-1 overflow-y-auto text-sm text-gray-200">
        {ordered.map((segment) => (
          <li
            key={segment.segmentId}
            data-testid={`live-transcript-${segment.sequence}`}
          >
            <span className="font-medium text-emerald-200">
              {segment.speaker}:{" "}
            </span>
            <span>{segment.text}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
