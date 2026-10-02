import { useEffect, useMemo, useRef, useState } from "react"

import type {
  LiveTranscriptSegment,
  LiveTranscriptState,
  RuntimeHostProjection,
} from "../room/types"

interface LiveTranscriptParticipant {
  peerId: string
  name: string
  kind?: "human" | "agent"
  runtimeHostId?: string
  connected?: boolean
}

interface LiveTranscriptControlProps {
  liveTranscript: LiveTranscriptState
  runtimeHosts?: Record<string, RuntimeHostProjection>
  localParticipantId?: string
  participants: LiveTranscriptParticipant[]
  mediaAvailable: boolean
  onStart: (runtimeHostId: string) => void
  onStop: () => void
}

interface LiveTranscriptSegmentsProps {
  segments: LiveTranscriptSegment[]
}

// Runtime Host ids are routing identifiers. Start is offered for an STT-ready
// Host represented by a currently connected Room Agent; the authenticated
// Human's explicit click is the authorization.
export function authorizedLiveTranscriptHosts({
  runtimeHosts,
  participants,
}: Pick<LiveTranscriptControlProps, "runtimeHosts" | "participants">): Array<
  [string, RuntimeHostProjection]
> {
  return Object.entries(runtimeHosts ?? {}).filter(
    ([runtimeHostId, host]) =>
      host.speech.stt === true &&
      participants.some(
        (participant) =>
          participant.kind === "agent" &&
          participant.connected === true &&
          participant.runtimeHostId === runtimeHostId
      )
  )
}

function runtimeHostName(
  runtimeHostId: string,
  participants: LiveTranscriptParticipant[]
): string {
  const member = participants.find(
    (participant) =>
      participant.kind === "agent" &&
      participant.connected === true &&
      participant.runtimeHostId === runtimeHostId
  )
  return member ? `${member.name} Runtime` : "Runtime"
}

// The Room header exposes one Live Transcript control. Start routes the
// Human-authorized operation to an exact connected STT-ready Runtime Host.
export function LiveTranscriptControl({
  liveTranscript = { active: false },
  runtimeHosts,
  participants = [],
  mediaAvailable = false,
  onStart,
  onStop,
}: LiveTranscriptControlProps) {
  const [open, setOpen] = useState(false)
  const [selectedRuntimeHostId, setSelectedRuntimeHostId] = useState("")
  const containerRef = useRef<HTMLDivElement>(null)
  const authorizedHosts = mediaAvailable
    ? authorizedLiveTranscriptHosts({
        runtimeHosts,
        participants,
      })
    : []
  const connectedRuntimeHostIds = new Set(
    participants
      .filter(
        (participant) =>
          participant.kind === "agent" &&
          participant.connected === true &&
          participant.runtimeHostId
      )
      .map((participant) => participant.runtimeHostId!)
  )
  const selectedHostId = authorizedHosts.some(
    ([runtimeHostId]) => runtimeHostId === selectedRuntimeHostId
  )
    ? selectedRuntimeHostId
    : authorizedHosts[0]?.[0] ?? ""

  // Popover lifetime: click-outside and Escape close it, matching the
  // existing room UI conventions; the underlying control semantics never
  // depend on popover state.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (selectedRuntimeHostId !== selectedHostId)
      setSelectedRuntimeHostId(selectedHostId)
  }, [selectedHostId, selectedRuntimeHostId])

  const unavailable = authorizedHosts.length === 0
  const active = liveTranscript.active

  return (
    <div
      ref={containerRef}
      className="relative"
      aria-label="Live Transcript controls"
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label="Live Transcript"
        className={
          active
            ? "flex items-center gap-1 rounded-md border border-emerald-700/60 bg-emerald-900/30 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-800/50"
            : "rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
        }
      >
        {active ? "● Live Transcript" : "Live Transcript"}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Live Transcript"
          className="room-feature-popover absolute right-0 top-full z-20 mt-1 max-h-[65dvh] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-gray-700 bg-gray-800 p-3 text-xs text-gray-200 shadow-lg"
        >
          {active ? (
            <>
              <p className="font-medium text-emerald-200">
                Live Transcript is on
              </p>
              <p className="mt-1 text-gray-400">
                Using{" "}
                {runtimeHostName(
                  liveTranscript.producerRuntimeHostId,
                  participants
                )}
              </p>
              <button
                type="button"
                onClick={onStop}
                className="mt-2 rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-1 text-xs text-rose-200 hover:bg-rose-800/50"
                title="Stop Live Transcript for everyone in this room"
              >
                Stop
              </button>
            </>
          ) : unavailable ? (
            <>
              <p className="font-medium text-gray-100">Live Transcript</p>
              <p className="mt-1 text-gray-400">
                Turn room audio into shared text.
              </p>
              {connectedRuntimeHostIds.size === 0 ? (
                <p className="mt-1 text-gray-400">
                  No Runtime Host is connected to this Room. Join an Agent
                  Runtime to enable transcription.
                </p>
              ) : (
                <p className="mt-1 text-gray-400">
                  No connected Runtime Host in this Room has transcription
                  ready. Configure STT credentials on a Runtime, then reconnect
                  or refresh readiness.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="font-medium text-gray-100">Live Transcript</p>
              {authorizedHosts.length === 0 ? (
                <p className="mt-1 text-gray-400">
                  Transcription is unavailable in this room right now.
                </p>
              ) : authorizedHosts.length === 1 ? (
                <>
                  <p className="mt-1 text-emerald-200">Ready to start.</p>
                  <button
                    type="button"
                    onClick={() => onStart(authorizedHosts[0][0])}
                    className="mt-2 rounded-md border border-emerald-700/60 bg-emerald-900/30 px-3 py-1 text-emerald-200 hover:bg-emerald-800/50"
                  >
                    Start
                  </button>
                </>
              ) : (
                <>
                  <p className="mt-1 text-gray-400">
                    Choose a transcription Runtime
                  </p>
                  <div className="mt-1.5 flex flex-col gap-1">
                    {authorizedHosts.map(([runtimeHostId]) => (
                      <label
                        key={runtimeHostId}
                        className="flex cursor-pointer items-center gap-2 rounded-md bg-gray-700/60 px-2 py-1.5 text-left text-gray-200 hover:bg-gray-700"
                      >
                        <input
                          type="radio"
                          name="live-transcript-runtime"
                          checked={selectedHostId === runtimeHostId}
                          onChange={() =>
                            setSelectedRuntimeHostId(runtimeHostId)
                          }
                        />
                        <span>
                          {runtimeHostName(runtimeHostId, participants)}
                        </span>
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => onStart(selectedHostId)}
                    className="mt-2 rounded-md border border-emerald-700/60 bg-emerald-900/30 px-3 py-1 text-emerald-200 hover:bg-emerald-800/50"
                  >
                    Start
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function LiveTranscriptSegments({
  segments = [],
}: LiveTranscriptSegmentsProps) {
  const ordered = useMemo(
    () => [...segments].sort((left, right) => left.sequence - right.sequence),
    [segments]
  )
  const latestSequence = ordered[ordered.length - 1]?.sequence
  const listRef = useRef<HTMLOListElement>(null)
  const nearBottomRef = useRef(true)
  const [expanded, setExpanded] = useState(false)
  const [showNew, setShowNew] = useState(false)

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    if (nearBottomRef.current) {
      list.scrollTop = list.scrollHeight
      setShowNew(false)
    } else {
      setShowNew(true)
    }
  }, [ordered.length, latestSequence])

  // Expansion changes only the list viewport, never the transcript. Keep the
  // latest row in view when the viewer was already following, without
  // announcing that a new transcript arrived for a layout-only change.
  useEffect(() => {
    const list = listRef.current
    if (list && nearBottomRef.current) list.scrollTop = list.scrollHeight
  }, [expanded])

  const onScroll = () => {
    const list = listRef.current
    if (!list) return
    nearBottomRef.current =
      list.scrollHeight - list.scrollTop - list.clientHeight <= 24
    if (nearBottomRef.current) setShowNew(false)
  }

  const jumpToLatest = () => {
    const list = listRef.current
    if (!list) return
    nearBottomRef.current = true
    list.scrollTop = list.scrollHeight
    setShowNew(false)
  }

  if (segments.length === 0) return null

  return (
    <section
      className="mx-4 mt-1 flex flex-none flex-col rounded border border-emerald-700/40 bg-emerald-950/20 px-3 py-1.5"
      aria-label="Live Transcript"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-emerald-100">
          Live Transcript
        </h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="live-transcript-segments"
          onClick={() => {
            if (expanded) {
              nearBottomRef.current = true
              setShowNew(false)
            }
            setExpanded((current) => !current)
          }}
          className="shrink-0 rounded border border-emerald-700/50 px-2 py-0.5 text-xs text-emerald-200 hover:bg-emerald-900/40"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
      <ol
        ref={listRef}
        id="live-transcript-segments"
        onScroll={onScroll}
        className={`mt-1 overflow-y-auto text-sm text-gray-200 ${
          expanded ? "max-h-40 space-y-1" : "max-h-16 space-y-0.5"
        }`}
        aria-live="polite"
      >
        {ordered.map((segment, index) => {
          const previous = ordered[index - 1]
          const startsSpeakerRun =
            !previous ||
            previous.participantId !== segment.participantId ||
            previous.speaker !== segment.speaker

          return (
            <li
              key={segment.segmentId}
              data-testid={`live-transcript-${segment.sequence}`}
              data-segment-id={segment.segmentId}
              className={startsSpeakerRun ? undefined : "pl-4"}
            >
              {startsSpeakerRun && (
                <span className="font-medium text-emerald-200">
                  {segment.speaker}:{" "}
                </span>
              )}
              {!startsSpeakerRun && (
                <span className="sr-only">{segment.speaker}: </span>
              )}
              <span>{segment.text}</span>
            </li>
          )
        })}
      </ol>
      {showNew && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="mt-1 self-end rounded border border-emerald-700/50 px-2 py-0.5 text-xs text-emerald-200 hover:bg-emerald-900/40"
        >
          New transcript · Jump to latest
        </button>
      )}
    </section>
  )
}
