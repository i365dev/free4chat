import React, { useState, useEffect, useRef, useCallback } from "react"

import { useRouter } from "next/router"

import { LOCAL_PEER_ID } from "@common/consts"

import AgentInviteControl from "./AgentInviteControl"
import { LiveTranscriptControl, LiveTranscriptSegments } from "./LiveTranscript"
import TextChatCard from "./TextChatCard"
import UserCard from "./UserCard"
import WorkspaceSnapshots from "./WorkspaceSnapshots"
import { buildAgentInvitePrompt } from "../common/agentInvite"
import type { UserInfo } from "../common/types"
import {
  umamiEvent,
  trackAnalyticsEvent,
  hashRoom,
  participantsBucket,
} from "../common/utils"
import { useSfuChatRoom } from "../hooks/useSfuChatRoom"
import { useTurnstile } from "../hooks/useTurnstile"

const REACTION_EMOJIS = ["👍", "😂", "🔥", "❓"]

function ScreenShareViewer({
  stream,
  name,
}: {
  stream: MediaStream
  name: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream
  }, [stream])

  const enterFullscreen = () => {
    const v = videoRef.current
    if (!v) return
    if (v.requestFullscreen) v.requestFullscreen()
    else if ((v as any).webkitEnterFullscreen)
      (v as any).webkitEnterFullscreen()
  }

  return (
    <div className="room-share-viewer relative min-h-0 flex-1 bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-contain"
      />
      <div className="room-share-viewer__label absolute bottom-2 left-2 rounded px-2 py-0.5 text-xs text-white">
        <span className="mr-1 text-cyan-300">●</span>
        {name} is sharing
      </div>
      <button
        className="room-share-viewer__fullscreen absolute bottom-2 right-2 rounded p-1 text-white"
        onClick={enterFullscreen}
        title="Fullscreen"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"
          />
        </svg>
      </button>
    </div>
  )
}

export default function RoomContent({
  roomName,
  nickName,
  roomType,
}: {
  roomName: string
  nickName: string
  roomType: "audio" | "screenshare"
}) {
  const router = useRouter()
  const [roomLinkCopied, setRoomLinkCopied] = useState(false)
  const [runtimeConnectError, setRuntimeConnectError] = useState("")
  // #236 follow-up: shared popover state so the Live Transcript setup copy
  // can cross-open the Invite Agent popover (no routing machinery).
  const [agentInviteOpen, setAgentInviteOpen] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<
    {
      id: string
      fileName: string
      isImage: boolean
      error?: boolean
      errorMessage?: string
    }[]
  >([])
  const [floatingReactions, setFloatingReactions] = useState<
    { id: number; emoji: string; x: number }[]
  >([])
  const processedReactionIds = useRef<Set<string>>(new Set())
  const joinedAtTs = useRef(Date.now().toString())

  const spawnReaction = useCallback((emoji: string) => {
    const id = Date.now() + Math.random()
    const x = 10 + Math.random() * 80
    setFloatingReactions((prev) => [...prev, { id, emoji, x }])
    setTimeout(
      () => setFloatingReactions((prev) => prev.filter((r) => r.id !== id)),
      2500
    )
  }, [])

  const { containerRef: turnstileContainerRef, requestToken } = useTurnstile()

  const {
    participants,
    getLocalRoomAuth,
    messages,
    attachments,
    sendTextMessage,
    sendFileMessage,
    sendActionMessage,
    sendCollabResponse,
    readRoomAttachment,
    sendCollabResult,
    muteSelf,
    toggleScreenShare,
    retryVerification,
    error,
    connectionStatus,
    resolvedRoomType,
    liveTranscript,
    liveTranscriptSegments,
    runtimeHosts,
    runtimeHostProviders,
    liveTranscriptMediaAvailable,
    startLiveTranscript,
    stopLiveTranscript,
    agentVoiceMediaAvailable,
    setAgentVoice,
    connectLocalRuntime,
    runtimeConnectionStatus,
    leaveRoom,
    localParticipantId,
  } = useSfuChatRoom(roomName, nickName, roomType, {
    getTurnstileToken: requestToken,
  })

  const screenshareAllowed = resolvedRoomType === "screenshare"

  const toggleAgentVoice = (participant: UserInfo) => {
    if (!participant.voiceAvailable) return
    const enabled = !participant.voiceEnabled
    setAgentVoice(participant.peerId, enabled)
    trackAnalyticsEvent(enabled ? "AgentVoiceStarted" : "AgentVoiceStopped", {
      roomType: resolvedRoomType,
    })
  }
  const handleStartLiveTranscript = (runtimeHostId: string) => {
    startLiveTranscript(runtimeHostId)
    trackAnalyticsEvent("LiveTranscriptStarted", {
      roomType: resolvedRoomType,
    })
  }

  const handleStopLiveTranscript = () => {
    stopLiveTranscript()
    trackAnalyticsEvent("LiveTranscriptStopped", {
      roomType: resolvedRoomType,
    })
  }

  const activeScreenShares = participants.filter(
    (p) =>
      p.screenShareEnabled && p.peerId !== LOCAL_PEER_ID && p.screenShareStream
  )
  const hasActiveScreenShare = activeScreenShares.length > 0
  const useConstellation = participants.length > 0 && participants.length <= 6

  const [activeSharePeerId, setActiveSharePeerId] = useState<string | null>(
    null
  )
  useEffect(() => {
    if (activeScreenShares.length === 0) {
      setActiveSharePeerId(null)
      return
    }
    if (
      !activeSharePeerId ||
      !activeScreenShares.find((p) => p.peerId === activeSharePeerId)
    ) {
      setActiveSharePeerId(activeScreenShares[0].peerId)
    }
  }, [activeScreenShares, activeSharePeerId])
  const activeShare =
    activeScreenShares.find((p) => p.peerId === activeSharePeerId) ??
    activeScreenShares[0] ??
    null

  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const [splitRatio, setSplitRatio] = useState(50)
  const [isMd, setIsMd] = useState(false)

  useEffect(() => {
    const check = () => setIsMd(window.innerWidth >= 768)
    check()
    window.addEventListener("resize", check)
    return () => window.removeEventListener("resize", check)
  }, [])

  useEffect(() => {
    setSplitRatio(activeScreenShares.length > 0 ? 75 : 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScreenShares.length > 0])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const ratio = ((e.clientX - rect.left) / rect.width) * 100
      setSplitRatio(Math.max(20, Math.min(80, ratio)))
    }
    const onMouseUp = () => {
      isDragging.current = false
    }
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    return () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    }
  }, [])

  const lastBucketRef = useRef<string>("")
  const activatedRoomRef = useRef(false)
  useEffect(() => {
    const bucket = participantsBucket(participants.length)
    if (bucket !== lastBucketRef.current) {
      lastBucketRef.current = bucket
      umamiEvent("RoomSize", {
        roomHash: hashRoom(roomName),
        bucket,
        roomType: resolvedRoomType,
      })
    }
  }, [participants.length, roomName, resolvedRoomType])

  useEffect(() => {
    if (
      activatedRoomRef.current ||
      connectionStatus !== "connected" ||
      participants.length < 2
    ) {
      return
    }

    const timeout = window.setTimeout(() => {
      activatedRoomRef.current = true
      trackAnalyticsEvent("RoomActivated", {
        roomType: resolvedRoomType,
        participantBucket: participantsBucket(participants.length),
        activationDelaySeconds: 30,
      })
    }, 30_000)

    return () => window.clearTimeout(timeout)
  }, [connectionStatus, participants.length, resolvedRoomType])

  // Human + Agent collaboration analytics: derived from canonical Room state
  // (the connected roster and persisted collaboration envelopes), never from
  // clicks. The tracker baselines the initial post-join snapshot (Agents and
  // collaboration lifecycle that predate this browser's observation stay
  // silent) and keeps page-lifetime dedup sets, so state refresh, resync
  // replay, reconnect, and re-render never re-count the same Agent or the
  // same canonical collab requestId.

  // #228: collaboration-truth analytics (AgentJoined / CollabRequested /
  // CollabOutcome) are Room/DO-authoritative now. The browser observers
  // were removed in the same rollout so a connected Human browser can
  // never double count canonical transitions. Acquisition / Human intent /
  // UI events (Pageview, invites, voice/notes/transcript controls) remain
  // browser-side.

  useEffect(() => {
    messages.forEach((m) => {
      if (m.type !== "action" || m.actionType !== "reaction") return
      const ts = m.actionPayload?.ts ?? "0"
      if (ts < joinedAtTs.current) return
      const msgId = `${m.peerId}-${m.actionPayload?.emoji}-${ts}`
      if (processedReactionIds.current.has(msgId)) return
      processedReactionIds.current.add(msgId)
      spawnReaction(m.actionPayload?.emoji ?? "👍")
    })
  }, [messages, spawnReaction])

  const hasSentTextRef = useRef(false)
  const wrappedSendText = (text: string, targets: string[] = []) => {
    if (!hasSentTextRef.current) {
      hasSentTextRef.current = true
      umamiEvent("ChatActivity", { type: "text", roomHash: hashRoom(roomName) })
    }
    sendTextMessage(text, targets)
  }

  const MAX_FILE_SIZE = 20 * 1024 * 1024

  const sendReaction = (emoji: string) => {
    sendActionMessage("reaction", { emoji, ts: Date.now().toString() })
  }

  const wrappedSendFile = async (file: File) => {
    const id = `${Date.now()}-${file.name}`
    if (file.size > MAX_FILE_SIZE) {
      setPendingFiles((prev) => [
        ...prev,
        {
          id,
          fileName: file.name,
          isImage: file.type.startsWith("image/"),
          error: true,
          errorMessage: `File too large (max 20 MB)`,
        },
      ])
      setTimeout(
        () => setPendingFiles((prev) => prev.filter((f) => f.id !== id)),
        3000
      )
      return
    }
    umamiEvent("ChatActivity", {
      type: file.type.startsWith("image/") ? "image" : "file",
      roomHash: hashRoom(roomName),
    })
    setPendingFiles((prev) => [
      ...prev,
      { id, fileName: file.name, isImage: file.type.startsWith("image/") },
    ])
    try {
      await sendFileMessage(file)
    } catch {
      setPendingFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? { ...f, error: true, errorMessage: "Failed to send" }
            : f
        )
      )
      setTimeout(
        () => setPendingFiles((prev) => prev.filter((f) => f.id !== id)),
        3000
      )
      return
    }
    setPendingFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const selfScreenShareRef = useRef(false)
  const [screenShareWarning, setScreenShareWarning] = useState("")
  const wrappedToggleScreenShare = () => {
    const isCurrentlySharing = participants.find(
      (p) => p.peerId === LOCAL_PEER_ID
    )?.screenShareEnabled
    if (!isCurrentlySharing) {
      const sharingCount = participants.filter(
        (p) => p.screenShareEnabled
      ).length
      if (sharingCount >= 3) {
        setScreenShareWarning("Max 3 screen shares allowed at once.")
        setTimeout(() => setScreenShareWarning(""), 3000)
        return
      }
    }
    selfScreenShareRef.current = !isCurrentlySharing
    umamiEvent("ScreenShare", {
      action: isCurrentlySharing ? "stop" : "start",
      roomHash: hashRoom(roomName),
    })
    toggleScreenShare()
  }

  const copyRoomLink = () => {
    if (typeof window !== "undefined") {
      const url =
        window.location.origin +
        "/room?id=" +
        encodeURIComponent(roomName) +
        (resolvedRoomType === "screenshare" ? "&type=screenshare" : "")
      navigator.clipboard.writeText(url)
      trackAnalyticsEvent("InviteLinkCopied", {
        surface: "room",
        roomType: resolvedRoomType,
      })
      setRoomLinkCopied(true)
      setTimeout(() => setRoomLinkCopied(false), 2000)
    }
  }

  const handleConnectRuntime = () => {
    setRuntimeConnectError("")
    void connectLocalRuntime().catch((connectError) => {
      setRuntimeConnectError(
        connectError instanceof Error
          ? connectError.message
          : "Unable to connect the local Runtime"
      )
    })
  }

  if (connectionStatus === "failed") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gray-950 text-white">
        <p className="mb-2 text-xl font-semibold text-gray-200">
          Connection lost
        </p>
        <p className="mb-6 text-sm text-gray-500">
          {error || "Could not reconnect after multiple attempts."}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md bg-rose-600 px-6 py-2 text-sm font-medium text-white hover:bg-rose-500 focus:outline-none focus:ring focus:ring-yellow-400"
        >
          Reload page
        </button>
      </main>
    )
  }

  if (
    (connectionStatus === "verifying" ||
      connectionStatus === "connecting" ||
      connectionStatus === "verification_failed") &&
    participants.length === 0
  ) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-950 px-4 text-center text-white">
        {connectionStatus === "verification_failed" ? (
          <>
            <p className="text-lg font-semibold text-gray-200">
              Verification failed
            </p>
            <p className="max-w-sm text-sm text-gray-500">
              {error || "We couldn't verify you're human. Please try again."}
            </p>
          </>
        ) : (
          <>
            <div className="h-16 w-16 animate-spin rounded-full border-4 border-gray-700 border-t-green-500" />
            <p className="text-sm text-gray-500">
              {connectionStatus === "verifying" ? "Verifying…" : "Joining…"}
            </p>
          </>
        )}
        {/* Bounded, interaction-only Turnstile mount point — stays empty
            unless Cloudflare decides the visitor needs to interact. */}
        <div ref={turnstileContainerRef} />
        {connectionStatus === "verification_failed" && (
          <button
            type="button"
            onClick={retryVerification}
            className="rounded-md bg-rose-600 px-6 py-2 text-sm font-medium text-white hover:bg-rose-500 focus:outline-none focus:ring focus:ring-yellow-400"
          >
            Try again
          </button>
        )}
      </main>
    )
  }

  return (
    <main className="room-shell flex h-screen flex-col overflow-hidden text-white">
      {connectionStatus === "reconnecting" && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60">
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-yellow-400" />
          <p className="text-sm text-gray-400">Reconnecting...</p>
        </div>
      )}

      <header className="room-header flex flex-none flex-col gap-2 border-b px-4 py-3 lg:flex-row lg:items-center">
        <div
          data-testid="room-header-identity"
          className="flex min-w-0 items-center gap-2"
        >
          <h1 className="min-w-0 flex-1 truncate font-mono text-lg font-medium tracking-wide text-cyan-100 lg:flex-none">
            #{roomName}
          </h1>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.22em] text-slate-500 sm:inline">
            temporary room · {participants.length} peer
            {participants.length === 1 ? "" : "s"} online
          </span>
          <button
            type="button"
            onClick={() => {
              leaveRoom()
              router.push("/")
            }}
            className="shrink-0 rounded-md border border-rose-800/80 bg-rose-950/30 px-3 py-1 text-xs text-rose-200 hover:border-rose-500/80 hover:bg-rose-950/60 lg:hidden"
          >
            Leave
          </button>
        </div>
        <div
          data-testid="room-header-features"
          className="flex flex-none flex-col gap-2 lg:ml-auto lg:flex-row lg:items-center lg:gap-2"
        >
          <div className="grid grid-cols-3 gap-2 lg:flex lg:items-center">
            <button
              type="button"
              onClick={copyRoomLink}
              className="flex min-w-0 items-center justify-center gap-1 rounded-md border border-slate-700/80 bg-slate-900/70 px-2 py-1 text-xs text-slate-300 hover:border-cyan-700/70 hover:bg-slate-800"
              title="Copy room link"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-3.5 w-3.5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
              <span className="truncate">
                {roomLinkCopied ? "Copied!" : "Copy link"}
              </span>
            </button>
            <AgentInviteControl
              roomType={resolvedRoomType}
              invitePrompt={buildAgentInvitePrompt(roomName)}
              open={agentInviteOpen}
              onOpenChange={setAgentInviteOpen}
            />
            <LiveTranscriptControl
              liveTranscript={liveTranscript}
              runtimeHosts={runtimeHosts}
              runtimeHostProviders={runtimeHostProviders}
              localParticipantId={localParticipantId}
              participants={participants}
              mediaAvailable={liveTranscriptMediaAvailable}
              onStart={handleStartLiveTranscript}
              onStop={handleStopLiveTranscript}
              onConnect={handleConnectRuntime}
              runtimeConnectionStatus={runtimeConnectionStatus}
              runtimeConnectError={runtimeConnectError}
              onSuggestInvite={() => setAgentInviteOpen(true)}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              leaveRoom()
              router.push("/")
            }}
            className="hidden shrink-0 rounded-md border border-rose-800/80 bg-rose-950/30 px-3 py-1 text-xs text-rose-200 hover:border-rose-500/80 hover:bg-rose-950/60 lg:inline-flex"
          >
            Leave
          </button>
        </div>
      </header>

      {error !== "" && (
        <div
          className="flex flex-none items-center gap-4 bg-gray-900 px-4 py-2 text-white"
          role="alert"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 text-amber-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <strong className="text-sm font-normal"> {error} </strong>
        </div>
      )}
      <LiveTranscriptSegments segments={liveTranscriptSegments} />
      {screenShareWarning !== "" && (
        <div
          className="mx-4 mt-1 flex flex-none items-center gap-4 rounded border border-amber-700/50 bg-amber-900/40 px-4 py-2 text-amber-200"
          role="alert"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 shrink-0 text-amber-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span className="text-sm">{screenShareWarning}</span>
        </div>
      )}

      <div
        ref={containerRef}
        className={`room-content flex min-h-0 flex-1 flex-col overflow-hidden ${
          hasActiveScreenShare ? "md:flex-row" : "room-content--stacked"
        }`}
      >
        <div
          className={`room-panel flex min-h-0 flex-col overflow-hidden ${
            hasActiveScreenShare
              ? "flex-1 border-b border-slate-800/80 md:flex-none md:border-b-0 md:border-r"
              : "w-full flex-none border-b border-slate-800/80"
          }`}
          style={
            hasActiveScreenShare && isMd
              ? { width: `${splitRatio}%` }
              : undefined
          }
        >
          {/* #111: Agent workspace snapshots — observation only, available in
              every room type; Human screen share is untouched below. */}
          <WorkspaceSnapshots
            participants={participants}
            getLocalRoomAuth={getLocalRoomAuth}
          />
          <div
            className={`relative flex flex-col overflow-hidden ${
              hasActiveScreenShare ? "min-h-0 flex-1" : "flex-none"
            }`}
          >
            {activeScreenShares.length > 0 ? (
              <>
                {activeShare && (
                  <ScreenShareViewer
                    key={activeShare.peerId}
                    stream={activeShare.screenShareStream!}
                    name={activeShare.name}
                  />
                )}
                <div className="room-participant-strip scrollbar-thin flex flex-none flex-row gap-2 overflow-x-auto border-t border-slate-800/80 p-2">
                  {participants.map((p) => (
                    <div
                      key={p.peerId}
                      className={`flex-shrink-0 rounded-xl transition-all ${
                        p.screenShareEnabled &&
                        p.peerId !== LOCAL_PEER_ID &&
                        p.peerId === activeSharePeerId
                          ? "shadow-[0_0_16px_rgba(103,232,249,0.26)] ring-1 ring-cyan-300"
                          : ""
                      } ${
                        p.screenShareEnabled && p.peerId !== LOCAL_PEER_ID
                          ? "cursor-pointer"
                          : ""
                      }`}
                      onClick={() => {
                        if (
                          p.screenShareEnabled &&
                          p.peerId !== LOCAL_PEER_ID
                        ) {
                          setActiveSharePeerId(p.peerId)
                        }
                      }}
                    >
                      <UserCard
                        peerId={p.peerId}
                        name={p.name}
                        kind={p.kind}
                        room={p.room}
                        muteState={p.muteState}
                        audioStream={p.audioStream}
                        screenShareStream={p.screenShareStream}
                        screenShareEnabled={p.screenShareEnabled}
                        onMuteSelf={muteSelf}
                        onToggleScreenShare={wrappedToggleScreenShare}
                        screenshareAllowed={screenshareAllowed}
                        voiceAvailable={
                          p.voiceAvailable && agentVoiceMediaAvailable
                        }
                        voiceEnabled={p.voiceEnabled}
                        onToggleAgentVoice={() => toggleAgentVoice(p)}
                        className="w-[5.25rem]"
                        compact
                        node
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div
                className={`room-participants-grid scrollbar-thin room-participants-grid--band gap-2 p-3 ${
                  useConstellation
                    ? "room-participants-grid--node-band"
                    : "room-participants-grid--card-band"
                }`}
              >
                {participants.map((p) => (
                  <div
                    key={p.peerId}
                    className="flex flex-col items-center gap-1"
                  >
                    <UserCard
                      peerId={p.peerId}
                      name={p.name}
                      kind={p.kind}
                      room={p.room}
                      muteState={p.muteState}
                      audioStream={p.audioStream}
                      screenShareStream={p.screenShareStream}
                      screenShareEnabled={p.screenShareEnabled}
                      onMuteSelf={muteSelf}
                      onToggleScreenShare={wrappedToggleScreenShare}
                      voiceAvailable={
                        p.voiceAvailable && agentVoiceMediaAvailable
                      }
                      voiceEnabled={p.voiceEnabled}
                      onToggleAgentVoice={() => toggleAgentVoice(p)}
                      screenshareAllowed={screenshareAllowed}
                      node={useConstellation}
                      className="w-full flex-none sm:w-40"
                    />
                    {p.peerId === LOCAL_PEER_ID && (
                      <div className="hidden items-center gap-1 md:flex">
                        {REACTION_EMOJIS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => sendReaction(emoji)}
                            className="rounded-full px-1.5 py-0.5 text-base transition-transform hover:scale-125 active:scale-95"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {floatingReactions.map((r) => (
              <div
                key={r.id}
                className="pointer-events-none absolute bottom-4 animate-float-up text-2xl"
                style={{ left: `${r.x}%` }}
              >
                {r.emoji}
              </div>
            ))}
          </div>
        </div>

        {hasActiveScreenShare && (
          <div
            className="hidden w-1 cursor-col-resize bg-slate-800/70 transition-colors hover:bg-cyan-500/50 active:bg-cyan-500 md:block"
            onMouseDown={(e) => {
              isDragging.current = true
              e.preventDefault()
            }}
          />
        )}

        <div className="room-panel flex min-h-0 flex-1 flex-col overflow-hidden">
          <TextChatCard
            room={roomName}
            nickName={nickName}
            messages={messages}
            attachments={attachments}
            participants={participants}
            pendingFiles={pendingFiles}
            onSendText={wrappedSendText}
            onSendFile={wrappedSendFile}
            onSendAction={sendActionMessage}
            localParticipantId={getLocalRoomAuth()?.participantId}
            onCollabRespond={(requestId, decision) => {
              sendCollabResponse(requestId, decision)
            }}
            onReadArtifact={(attachmentId) => readRoomAttachment(attachmentId)}
            onCollabResult={(requestId, status, summary) => {
              sendCollabResult(requestId, status, summary)
            }}
          />
        </div>
      </div>
    </main>
  )
}
