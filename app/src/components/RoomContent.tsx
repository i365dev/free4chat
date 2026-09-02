import React, { useState, useEffect, useRef, useCallback } from "react"

import { useRouter } from "next/router"

import { LOCAL_PEER_ID } from "@common/consts"
import {
  MAX_ADVERTISED_CAPABILITIES,
  MAX_COLLAB_SUMMARY_LENGTH,
  MAX_CAPABILITY_LENGTH,
} from "@do/collab"

import AgentWorkRequestComposer from "./AgentWorkRequestComposer"
import HumanCapabilitiesEditor from "./HumanCapabilitiesEditor"
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
    <div className="relative min-h-0 flex-1 bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-contain"
      />
      <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {name}
      </div>
      <button
        className="absolute bottom-2 right-2 rounded bg-black/60 p-1 text-white hover:bg-black/80"
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
  const [agentInviteCopied, setAgentInviteCopied] = useState(false)
  const [agentInviteError, setAgentInviteError] = useState("")
  const [runtimeConnectError, setRuntimeConnectError] = useState("")
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
    sendTextMessage,
    sendFileMessage,
    sendActionMessage,
    sendCollabRequest,
    uploadRoomAttachment,
    sendCollabResponse,
    readRoomAttachment,
    sendCollabResult,
    updateHumanCapabilities,
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

  // #113: Human → Agent structured work request entry point. The callback is
  // passed ONLY for remote connected Agents; Humans and self never get it.
  const [workRequestTarget, setWorkRequestTarget] = useState<UserInfo | null>(
    null
  )
  // #119: local-Human capability editor target (self only).
  const [capabilitiesEditorOpen, setCapabilitiesEditorOpen] = useState(false)
  const requestWorkFor = (p: UserInfo) =>
    setWorkRequestTarget(
      p.kind === "agent" && p.peerId !== LOCAL_PEER_ID ? p : null
    )

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

  const writeAgentInvite = (invite: string) => {
    // This function is intentionally called directly from a click handler.
    // Firefox and Safari require transient user activation for clipboard
    // writes, so never move this call behind an asynchronous Room round-trip.
    if (!navigator.clipboard?.writeText) {
      setAgentInviteError(
        "Clipboard access is unavailable. Copy invite is not supported here."
      )
      return
    }
    void navigator.clipboard
      .writeText(invite)
      .then(() => {
        trackAnalyticsEvent("AgentInviteCopied", {
          surface: "room",
          roomType: resolvedRoomType,
        })
        setAgentInviteError("")
        setAgentInviteCopied(true)
        setTimeout(() => setAgentInviteCopied(false), 2000)
      })
      .catch(() => {
        setAgentInviteError(
          "Clipboard access was blocked. Click Copy invite to try again."
        )
      })
  }

  const copyAgentInvite = () => {
    if (typeof window === "undefined") return
    writeAgentInvite(buildAgentInvitePrompt(roomName))
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
    <main className="flex h-screen flex-col overflow-hidden bg-gray-900 text-white">
      {connectionStatus === "reconnecting" && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60">
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-yellow-400" />
          <p className="text-sm text-gray-400">Reconnecting...</p>
        </div>
      )}

      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-gray-800 px-4 py-3">
        <h1 className="min-w-0 truncate text-lg font-medium">#{roomName}</h1>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={copyRoomLink}
            className="flex items-center gap-1 rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
            title="Copy room link"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5"
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
            {roomLinkCopied ? "Copied!" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={copyAgentInvite}
            className="rounded-md border border-blue-700/70 bg-blue-900/30 px-3 py-1 text-xs text-blue-200 hover:bg-blue-800/50"
            title="Copy Agent invite prompt"
          >
            {agentInviteCopied ? "Copied!" : "Invite Agent"}
          </button>
          {agentInviteError && (
            <span role="status" className="text-xs text-rose-300">
              {agentInviteError}
            </span>
          )}
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
          />
          {runtimeConnectError && (
            <span role="status" className="text-xs text-rose-300">
              {runtimeConnectError}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              leaveRoom()
              router.push("/")
            }}
            className="rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
          >
            Leave
          </button>
        </div>
      </div>

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
        className="flex flex-1 flex-col overflow-hidden md:flex-row"
      >
        <div
          className="flex flex-1 flex-col overflow-hidden border-b border-gray-800 md:flex-none md:border-b-0 md:border-r"
          style={isMd ? { width: `${splitRatio}%` } : undefined}
        >
          {/* #111: Agent workspace snapshots — observation only, available in
              every room type; Human screen share is untouched below. */}
          <WorkspaceSnapshots
            participants={participants}
            getLocalRoomAuth={getLocalRoomAuth}
          />
          <div className="relative flex flex-1 flex-col overflow-hidden">
            {activeScreenShares.length > 0 ? (
              <>
                {activeShare && (
                  <ScreenShareViewer
                    key={activeShare.peerId}
                    stream={activeShare.screenShareStream!}
                    name={activeShare.name}
                  />
                )}
                <div className="scrollbar-thin flex flex-none flex-row gap-2 overflow-x-auto border-t border-gray-800 p-2">
                  {participants.map((p) => (
                    <div
                      key={p.peerId}
                      className={`flex-shrink-0 rounded-xl transition-all ${
                        p.screenShareEnabled &&
                        p.peerId !== LOCAL_PEER_ID &&
                        p.peerId === activeSharePeerId
                          ? "ring-2 ring-blue-400"
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
                        onRequestWork={() => requestWorkFor(p)}
                        voiceAvailable={
                          p.voiceAvailable && agentVoiceMediaAvailable
                        }
                        voiceEnabled={p.voiceEnabled}
                        onToggleAgentVoice={() => toggleAgentVoice(p)}
                        className="w-20"
                        compact
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="scrollbar-thin flex h-full flex-wrap content-start items-stretch gap-2 overflow-y-auto p-3">
                {participants.map((p) => (
                  <div
                    key={p.peerId}
                    className="flex h-full flex-col items-center gap-1"
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
                      onRequestWork={() => requestWorkFor(p)}
                      voiceAvailable={
                        p.voiceAvailable && agentVoiceMediaAvailable
                      }
                      voiceEnabled={p.voiceEnabled}
                      onToggleAgentVoice={() => toggleAgentVoice(p)}
                      screenshareAllowed={screenshareAllowed}
                      onEditCapabilities={
                        p.kind === "human" && p.peerId === LOCAL_PEER_ID
                          ? () => setCapabilitiesEditorOpen(true)
                          : undefined
                      }
                      className="w-40 flex-none"
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

        <div
          className="hidden w-1 cursor-col-resize bg-gray-800 transition-colors hover:bg-blue-500/50 active:bg-blue-500 md:block"
          onMouseDown={(e) => {
            isDragging.current = true
            e.preventDefault()
          }}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          <TextChatCard
            room={roomName}
            nickName={nickName}
            messages={messages}
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

      {workRequestTarget && (
        <AgentWorkRequestComposer
          agentName={workRequestTarget.name}
          capabilities={workRequestTarget.capabilities}
          maxLength={MAX_COLLAB_SUMMARY_LENGTH}
          onCancel={() => setWorkRequestTarget(null)}
          onSubmit={async (summary, files) => {
            // Sequential upload of each artifact through the existing
            // authenticated Room attachment endpoint.
            const attachmentIds: string[] = []
            for (const file of files) {
              const meta = await uploadRoomAttachment(file)
              attachmentIds.push(meta.id)
            }
            // sendCollabRequest returns "" when the WS is closed or local
            // validation fails; propagate that so the composer stays open.
            const requestId = sendCollabRequest(
              workRequestTarget.peerId,
              summary,
              attachmentIds.length > 0 ? attachmentIds : undefined
            )
            if (!requestId) return false
            setWorkRequestTarget(null)
            return true
          }}
        />
      )}

      {capabilitiesEditorOpen && (
        <HumanCapabilitiesEditor
          initialCapabilities={(
            participants.find((p) => p.peerId === LOCAL_PEER_ID)
              ?.capabilities ?? []
          ).filter((token): token is string => typeof token === "string")}
          maxLength={MAX_CAPABILITY_LENGTH}
          maxTokens={MAX_ADVERTISED_CAPABILITIES}
          onCancel={() => setCapabilitiesEditorOpen(false)}
          onSave={(capabilities) => {
            updateHumanCapabilities(capabilities)
            setCapabilitiesEditorOpen(false)
          }}
        />
      )}
    </main>
  )
}
