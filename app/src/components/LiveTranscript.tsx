import { useEffect, useMemo, useRef, useState } from "react"

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
  onConnect?: () => void
  runtimeConnectionStatus?: "idle" | "preparing" | "copied"
  /** #236: feature-specific setup error shown INSIDE the Live Transcript
   * popover; it never expands the Room header. */
  runtimeConnectError?: string
  /** #236 follow-up: opens the Invite Agent popover (shared RoomContent
   * state) so the setup copy can point new Humans at the Agent-first path. */
  onSuggestInvite?: () => void
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

// #236: the Room header exposes exactly ONE Live Transcript control. All
// setup/readiness/provider detail lives inside the anchored feature popover
// so the toolbar never turns into a Runtime diagnostics strip. The
// interaction, authorization, claim security, epoch/start/stop semantics and
// #206 refresh recovery are unchanged — this is presentation only.
export function LiveTranscriptControl({
  liveTranscript = { active: false },
  runtimeHosts,
  runtimeHostProviders,
  localParticipantId,
  participants = [],
  mediaAvailable = false,
  onStart,
  onStop,
  onConnect,
  runtimeConnectionStatus = "idle",
  runtimeConnectError = "",
  onSuggestInvite,
}: LiveTranscriptControlProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const authorizedHosts = mediaAvailable
    ? authorizedLiveTranscriptHosts({
        runtimeHosts,
        runtimeHostProviders,
        localParticipantId,
      })
    : []

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

  const unavailable = authorizedHosts.length === 0
  const connecting = runtimeConnectionStatus === "preparing"
  const copied = runtimeConnectionStatus === "copied"
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
          className="absolute right-0 top-full z-20 mt-1 w-72 rounded-md border border-gray-700 bg-gray-800 p-3 text-xs text-gray-200 shadow-lg"
        >
          {active ? (
            <>
              <p className="font-medium text-emerald-200">
                Live Transcript is on
              </p>
              <p className="mt-1 text-gray-400">
                Provided by{" "}
                {providerName({
                  liveTranscript,
                  participants,
                  localParticipantId,
                })}
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
          ) : unavailable && onConnect ? (
            <>
              <p className="font-medium text-gray-100">Live Transcript</p>
              <p className="mt-1 text-gray-400">
                Turn room audio into shared text.
              </p>
              <p className="mt-1 text-gray-400">
                Live Transcript needs transcription support from your local
                Free4Chat setup.
              </p>
              {onSuggestInvite && (
                <p className="mt-1 text-gray-400">
                  If you haven&apos;t connected an Agent yet, start with Invite
                  Agent.
                </p>
              )}
              {onSuggestInvite && (
                <button
                  type="button"
                  onClick={onSuggestInvite}
                  className="mt-1.5 rounded-md border border-blue-700/70 bg-blue-900/30 px-3 py-1 text-blue-200 hover:bg-blue-800/50"
                >
                  Start with Invite Agent
                </button>
              )}
              <p className="mt-1.5 text-gray-400">
                Already have Free4Chat running locally?
              </p>
              <button
                type="button"
                onClick={onConnect}
                disabled={connecting}
                className="mt-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-gray-200 hover:bg-gray-700 disabled:cursor-wait disabled:opacity-50"
                title="Copy the connection command for the computer where Free4Chat is running"
              >
                {connecting ? "Preparing…" : "Copy connection command"}
              </button>
              <p className="mt-1.5 text-gray-400">
                Run this command in the terminal where Free4Chat is running. Do
                not paste it into an Agent chat.
              </p>
              {copied && (
                <p role="status" className="mt-2 text-emerald-300">
                  ✓ Connection command copied. Run it in your terminal.
                </p>
              )}
              {runtimeConnectError && (
                <p role="status" className="mt-2 text-rose-300">
                  {runtimeConnectError}
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
                    {authorizedHosts.map(([runtimeHostId], index) => (
                      <button
                        key={runtimeHostId}
                        type="button"
                        onClick={() => onStart(runtimeHostId)}
                        className="w-full rounded-md bg-gray-700/60 px-2 py-1.5 text-left text-gray-200 hover:bg-gray-700"
                      >
                        Your STT-ready Runtime {index + 1}
                      </button>
                    ))}
                  </div>
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
      className="mx-4 mt-1 flex flex-none flex-col rounded border border-emerald-700/40 bg-emerald-950/20 px-4 py-2"
      aria-label="Live Transcript"
    >
      <h2 className="text-sm font-medium text-emerald-100">Live Transcript</h2>
      <ol
        ref={listRef}
        onScroll={onScroll}
        className="mt-1 max-h-40 space-y-1 overflow-y-auto text-sm text-gray-200"
        aria-live="polite"
      >
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
