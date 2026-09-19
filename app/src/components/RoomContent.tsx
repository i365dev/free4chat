import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"

import { useRouter } from "next/router"

import { LOCAL_PEER_ID } from "@common/consts"
import { MAX_COLLAB_SUMMARY_LENGTH } from "@do/collab"

import AgentInviteControl from "./AgentInviteControl"
import { LiveTranscriptControl, LiveTranscriptSegments } from "./LiveTranscript"
import RoomAppHost from "./RoomAppHost"
import RoomAppLauncher from "./RoomAppLauncher"
import RoomAudioSinks from "./RoomAudioSinks"
import TaskLiveView from "./TaskLiveView"
import TextChatCard from "./TextChatCard"
import UserCard from "./UserCard"
import WorkspaceSnapshots from "./WorkspaceSnapshots"
import { agentActivityLabel } from "../common/agentActivity"
import { buildAgentInvitePrompt } from "../common/agentInvite"
import {
  buildRoomInviteUrl,
  currentRoomAppCatalog,
  isRoomAppAllowlisted,
  loadProductionRoomAppCatalog,
  resolveProductionRoomAppId,
  ROOM_APP_MAX_INSTANCES,
  projectRoomAppParticipants,
  ROOM_APP_CATALOG_REFRESH_INTERVAL_MS,
  roomAppInstanceId,
  setProductionRoomAppCatalog,
  validateRoomAppDefinition,
} from "../common/roomApp"
import { withAcquisitionPage } from "../common/roomAppAcquisition"
import {
  inlineRoomAppIds,
  pruneRecentRoomAppIds,
  pushRecentRoomAppId,
  readRecentRoomAppIds,
  ROOM_APP_INLINE_RECENT_MAX,
  ROOM_APP_INLINE_RECENT_MAX_DESKTOP,
  writeRecentRoomAppIds,
} from "../common/roomAppRecents"
import {
  buildTaskProjections,
  isTaskTerminal,
  roomMessagesForView,
  taskHasConnectedAgent,
  type TaskProjection,
} from "../common/taskViews"
import type { UserInfo } from "../common/types"
import {
  umamiEvent,
  trackAnalyticsEvent,
  hashRoom,
  participantsBucket,
} from "../common/utils"
import { useSfuChatRoom, type RoomMicState } from "../hooks/useSfuChatRoom"
import { useTurnstile } from "../hooks/useTurnstile"

const MAX_FILE_SIZE = 20 * 1024 * 1024

type TaskAgent = { peerId: string; name: string }

/**
 * #402 canonical Human microphone control.
 *
 * Room-owned chrome, never a Stage surface: the same control and the same hook
 * state drive the header button and the minimal fullscreen safety affordance,
 * so voice stays reachable while a Room App, screen share or Live View owns the
 * Stage — and while Room App fullscreen hides the ordinary header.
 */
function RoomMicControl({
  micState,
  enabled,
  onToggle,
  testId,
  fullscreen = false,
}: {
  micState: RoomMicState
  enabled: boolean
  onToggle: () => void
  testId: string
  fullscreen?: boolean
}) {
  const label =
    micState === "requesting"
      ? fullscreen
        ? "…"
        : "Enabling…"
      : micState === "live"
      ? fullscreen
        ? "Mic"
        : "Mic on"
      : micState === "muted"
      ? "Muted"
      : micState === "unavailable"
      ? "Retry mic"
      : "Enable mic"
  const action =
    micState === "live"
      ? "Mute microphone"
      : micState === "muted"
      ? "Unmute microphone"
      : micState === "requesting"
      ? "Requesting microphone access"
      : micState === "unavailable"
      ? "Retry microphone access"
      : "Enable microphone"
  const tone =
    micState === "live"
      ? "border-emerald-600/60 text-emerald-200"
      : micState === "muted"
      ? "border-amber-600/50 text-amber-200"
      : micState === "unavailable"
      ? "border-amber-600/50 text-amber-200"
      : "border-gray-700 text-gray-300"

  return (
    <button
      type="button"
      data-testid={testId}
      data-mic-state={micState}
      onClick={onToggle}
      disabled={!enabled || micState === "requesting"}
      aria-pressed={micState === "live"}
      aria-label={action}
      title={action}
      className={
        fullscreen
          ? `pointer-events-auto flex items-center gap-1.5 rounded-full border bg-gray-900/90 px-3 py-1.5 text-xs backdrop-blur ${tone}`
          : `flex min-w-0 items-center justify-center gap-1 rounded-md border bg-gray-800 px-2 py-1 text-xs hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 ${tone}`
      }
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        {micState === "live" ? (
          <>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
            />
          </>
        ) : (
          <>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
          </>
        )}
      </svg>
      <span className="truncate">{label}</span>
    </button>
  )
}

function taskIsUnavailable(
  task: Pick<TaskProjection, "participatingAgentIds" | "status">,
  participants: Pick<UserInfo, "peerId" | "kind">[]
): boolean {
  return (
    !isTaskTerminal(task.status) && !taskHasConnectedAgent(task, participants)
  )
}

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
  initialRoomAppId,
  acquisitionPage,
}: {
  roomName: string
  nickName: string
  roomType: "audio" | "screenshare"
  initialRoomAppId?: string
  /**
   * #134: the bounded discovery slug that acquired this browser Room session,
   * or undefined for a direct launch. It is an acquisition intent, not the
   * current App: it stays fixed while `app` changes across App switches.
   */
  acquisitionPage?: string
}) {
  const router = useRouter()
  const [roomLinkCopied, setRoomLinkCopied] = useState(false)
  const [runtimeConnectError, setRuntimeConnectError] = useState("")
  const [taskAgent, setTaskAgent] = useState<TaskAgent | null>(null)
  const [taskInstruction, setTaskInstruction] = useState("")
  const [taskError, setTaskError] = useState("")
  const [activeInteraction, setActiveInteraction] = useState("room")
  const [activeRoomAppId, setActiveRoomAppId] = useState<string | null>(null)
  const [expandedRoomAppId, setExpandedRoomAppId] = useState<string | null>(
    null
  )
  // Browser-local resident App sessions, bounded by the curated catalog size.
  const [launchedRoomAppIds, setLaunchedRoomAppIds] = useState<string[]>([])
  const [readyRoomAppIds, setReadyRoomAppIds] = useState<string[]>([])
  // #98: the Apps this browser tab actually opened in THIS Room, most recent
  // first. Room-scoped and session-scoped only: no accounts, no favorites, no
  // cross-device preferences, and never `localStorage`.
  const [recentRoomAppIds, setRecentRoomAppIds] = useState<string[]>([])
  const [roomAppsLauncherOpen, setRoomAppsLauncherOpen] = useState(false)
  // Core's Stage/Chat split breakpoint, also used to size the inline recent set
  // and to decide between the desktop popover and the phone-fitted launcher.
  const [isMd, setIsMd] = useState(false)
  const [loadedRoomAppCatalog, setLoadedRoomAppCatalog] = useState(() =>
    process.env.NODE_ENV !== "production" ? currentRoomAppCatalog() : null
  )
  const [roomAppCatalogLoaded, setRoomAppCatalogLoaded] = useState(
    () => process.env.NODE_ENV === "test"
  )
  const initialRoomAppLaunchAttemptedRef = useRef(false)
  // Host-owned coarse telemetry stays catalog-derived: any curated production
  // App reports at most one shared-session milestone per browser Room session.
  const sharedSessionTrackedAppIdsRef = useRef<Set<string>>(new Set())
  // The acquisition intent is stable for this Room page, so the App-milestone
  // callbacks can read it without depending on the prop and being re-created.
  const acquisitionPageRef = useRef<string | undefined>(acquisitionPage)
  acquisitionPageRef.current = acquisitionPage
  const [stageView, setStageView] = useState<"screen" | "live-view">("screen")
  const taskLiveViewState = useRef(new Map())
  const observedLiveViewKeys = useRef(new Set<string>())
  const interactedLiveViewKeys = useRef(new Set<string>())
  const pendingLocalTaskSummaries = useRef<string[]>([])
  const autoOpenedTaskIds = useRef<Set<string>>(new Set())
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
    taskLiveViews,
    sendTextMessage,
    sendFileMessage,
    sendTaskAttachment,
    sendActionMessage,
    sendCollabRequest,
    sendCollabResponse,
    readRoomAttachment,
    sendCollabResult,
    sendPermissionResponse,
    localMicState,
    toggleMicrophone,
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
    agentActivities,
    roomAppsEnabled,
    sendRoomAppMessage,
    subscribeRoomAppMessages,
    sendRoomAppUnicast,
    subscribeRoomAppUnicast,
    subscribeRoomAppUnicastResults,
  } = useSfuChatRoom(roomName, nickName, roomType, {
    getTurnstileToken: requestToken,
  })

  const taskProjections = useMemo(
    () => buildTaskProjections(messages),
    [messages]
  )
  const effectiveLocalParticipantId =
    localParticipantId ?? getLocalRoomAuth()?.participantId
  useEffect(() => {
    if (process.env.NODE_ENV === "test") return
    let mounted = true
    const refreshCatalog = () => {
      void loadProductionRoomAppCatalog().then((catalog) => {
        if (!mounted) return
        setProductionRoomAppCatalog(catalog)
        setLoadedRoomAppCatalog(catalog)
        setRoomAppCatalogLoaded(true)
      })
    }
    refreshCatalog()
    const refreshTimer = window.setInterval(
      refreshCatalog,
      ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
    )
    return () => {
      mounted = false
      window.clearInterval(refreshTimer)
    }
  }, [])

  // Refreshing the same bounded Lab catalog keeps long-lived browser Rooms
  // aligned with the Room authority's catalog TTL. Local `yarn dev` uses the
  // same fixed-origin catalog; the Lab permits only exact localhost origins.
  // `roomAppsEnabled` is not a pure catalog/kill-switch signal: it also drops
  // while an ordinary SFU/media reconnect rebuilds the App DataChannels, and
  // that transient false must never be mistaken for a catalog removal.
  const curatedRoomApps = useMemo(
    () =>
      (loadedRoomAppCatalog ?? []).filter(
        (app) => validateRoomAppDefinition(app) && isRoomAppAllowlisted(app)
      ),
    [loadedRoomAppCatalog]
  )
  // Stable reference: `roomAppsEnabled` also drops during an ordinary transport
  // reconnect, and every catalog-derived memo below must stay referentially
  // stable across a render that does not actually change the App list.
  const roomApps = useMemo(
    () =>
      roomAppsEnabled && loadedRoomAppCatalog !== null ? curatedRoomApps : [],
    [curatedRoomApps, loadedRoomAppCatalog, roomAppsEnabled]
  )
  // #98: the inline Stage strip is progressive disclosure, so it never renders
  // the whole catalog. Recency is filtered against the CURRENT catalog, which
  // is why a removed App silently leaves both the strip and the launcher.
  const availableRoomAppIds = useMemo(
    () => new Set(roomApps.map((app) => app.id)),
    [roomApps]
  )
  const prunedRecentRoomAppIds = useMemo(
    () => pruneRecentRoomAppIds(recentRoomAppIds, availableRoomAppIds),
    [availableRoomAppIds, recentRoomAppIds]
  )
  const inlineRoomApps = useMemo(() => {
    const ids = inlineRoomAppIds(
      prunedRecentRoomAppIds,
      activeRoomAppId,
      availableRoomAppIds,
      isMd ? ROOM_APP_INLINE_RECENT_MAX_DESKTOP : ROOM_APP_INLINE_RECENT_MAX
    )
    return ids.flatMap((id) => {
      const app = roomApps.find((candidate) => candidate.id === id)
      return app ? [app] : []
    })
  }, [
    activeRoomAppId,
    availableRoomAppIds,
    isMd,
    prunedRecentRoomAppIds,
    roomApps,
  ])
  // Conversation scope and visual Stage are independent selections: an active
  // Room App lives on the Stage and never replaces the Room/Task conversation.
  const activeRoomApp = roomApps.find((app) => activeRoomAppId === app.id)
  const roomAppParticipants = projectRoomAppParticipants(
    participants.map((participant) => ({
      participantId:
        participant.peerId === LOCAL_PEER_ID
          ? effectiveLocalParticipantId ?? ""
          : participant.peerId,
      name: participant.name,
      kind: participant.kind,
    }))
  )
  const roomAppSelf = roomAppParticipants.find(
    (participant) => participant.participantId === effectiveLocalParticipantId
  )
  // Hosts are mounted on first launch and then stay resident for this browser's
  // Room session: Stage navigation only changes which one is visible, so an App
  // never loses its iframe/MessagePort/App-local state to visual navigation.
  // Resident resolution uses the stable curated catalog, not the transient
  // transport-readiness flag.
  const residentRoomApps = useMemo(
    () =>
      launchedRoomAppIds.flatMap((id) => {
        const app = curatedRoomApps.find((candidate) => candidate.id === id)
        return app ? [app] : []
      }),
    [curatedRoomApps, launchedRoomAppIds]
  )
  const humanParticipantCount = roomAppParticipants.filter(
    (participant) => participant.kind === "human"
  ).length
  const humanParticipantCountRef = useRef(humanParticipantCount)
  humanParticipantCountRef.current = humanParticipantCount
  // The shared-use milestone belongs to the catalog, not to one App: the first
  // resident production App that finished its handshake is the milestone App.
  const sharedSessionRoomAppId = residentRoomApps
    .filter((app) => readyRoomAppIds.includes(app.id))
    .map((app) => resolveProductionRoomAppId(app.id))
    .find((appId): appId is string => appId !== null)
  const visibleRoomApp =
    activeRoomApp && roomAppSelf ? activeRoomApp : undefined
  // Focus mode is a Room layout state, not just a larger host. The resident
  // host remains in its Stage subtree; all surrounding Room UI is made inert
  // and removed from layout so nested stacking contexts cannot paint over or
  // intercept input from the fixed host.
  const isRoomAppFullscreen = Boolean(
    roomAppSelf &&
      expandedRoomAppId &&
      expandedRoomAppId === activeRoomAppId &&
      residentRoomApps.some((app) => app.id === expandedRoomAppId)
  )
  const activeTask = taskProjections.find(
    (task) => task.requestId === activeInteraction
  )
  const activeTaskLiveView = activeTask
    ? taskLiveViews?.[activeTask.requestId]
    : undefined
  const handleLiveViewVisible = useCallback(
    (taskRequestId: string, surfaceId: string) => {
      const key = `${taskRequestId}:${surfaceId}`
      if (observedLiveViewKeys.current.has(key)) return
      observedLiveViewKeys.current.add(key)
      trackAnalyticsEvent("LiveViewVisible")
    },
    []
  )
  const handleLiveViewInteracted = useCallback(
    (taskRequestId: string, surfaceId: string) => {
      const key = `${taskRequestId}:${surfaceId}`
      if (interactedLiveViewKeys.current.has(key)) return
      interactedLiveViewKeys.current.add(key)
      trackAnalyticsEvent("LiveViewInteracted")
    },
    []
  )
  const interactionMessages = activeTask
    ? activeTask.messages
    : roomMessagesForView(messages)
  const referencedAttachmentIds = new Set(
    interactionMessages.flatMap(
      (message) => message.collab?.attachmentIds ?? []
    )
  )
  const roomAttachments = attachments ?? []
  const interactionAttachments = activeTask
    ? roomAttachments.filter(
        (attachment) =>
          attachment.taskRequestId === activeTask.requestId &&
          !referencedAttachmentIds.has(attachment.id)
      )
    : roomAttachments.filter(
        (attachment) =>
          attachment.taskRequestId === undefined &&
          !referencedAttachmentIds.has(attachment.id)
      )
  const activeTaskActivities = activeTask
    ? (agentActivities ?? []).filter(
        (activity) =>
          activity.scopeId === `task:${activeTask.requestId}` &&
          participants.some(
            (participant) =>
              participant.peerId === activity.agentParticipantId &&
              participant.kind === "agent"
          )
      )
    : []
  const activeTaskUnavailable = Boolean(
    activeTask && taskIsUnavailable(activeTask, participants)
  )

  useEffect(() => {
    const pending = pendingLocalTaskSummaries.current
    const created =
      effectiveLocalParticipantId && pending.length > 0
        ? taskProjections.find(
            (task) =>
              task.createdByParticipantId === effectiveLocalParticipantId &&
              pending.includes(task.title)
          )
        : undefined
    if (created) {
      pending.splice(pending.indexOf(created.title), 1)
      autoOpenedTaskIds.current.add(created.requestId)
      setActiveInteraction(created.requestId)
      return
    }

    // Preserve the existing Human-facing collaboration controls: an incoming
    // request addressed to this Human opens its task view so Accept/Decline
    // remains visible, while unrelated task views stay behind the switcher.
    if (activeInteraction !== "room" || !effectiveLocalParticipantId) return
    const incoming = taskProjections.find(
      (task) =>
        task.targetParticipantId === effectiveLocalParticipantId &&
        !autoOpenedTaskIds.current.has(task.requestId)
    )
    if (incoming) {
      autoOpenedTaskIds.current.add(incoming.requestId)
      setActiveInteraction(incoming.requestId)
    }
  }, [activeInteraction, effectiveLocalParticipantId, taskProjections])

  useEffect(() => {
    // A conversation scope is only ever "room" or a known Task. The Stage
    // selection (screen share, Live View, Room App) is stored separately.
    if (
      activeInteraction !== "room" &&
      !taskProjections.some((task) => task.requestId === activeInteraction)
    )
      setActiveInteraction("room")
  }, [activeInteraction, taskProjections])

  useEffect(() => {
    // Resident hosts survive presentation changes and ordinary transport
    // reconnects; they are torn down only when Room Apps are stably unavailable
    // (the Room is connected/failed and the flag is still off, which covers
    // ROOM_APPS_ENABLED being turned off) or when the curated catalog truly no
    // longer offers the entry. Unmounting the Room closes them as well.
    const stablyUnavailable =
      !roomAppsEnabled &&
      (connectionStatus === "connected" || connectionStatus === "failed")
    const hostIsGone = (id: string) =>
      stablyUnavailable || !curatedRoomApps.some((app) => app.id === id)
    if (activeRoomAppId && hostIsGone(activeRoomAppId)) setActiveRoomAppId(null)
    if (expandedRoomAppId && hostIsGone(expandedRoomAppId))
      setExpandedRoomAppId(null)
    setLaunchedRoomAppIds((previous) => {
      const next = previous.filter((id) => !hostIsGone(id))
      return next.length === previous.length ? previous : next
    })
  }, [
    activeRoomAppId,
    connectionStatus,
    curatedRoomApps,
    expandedRoomAppId,
    roomAppsEnabled,
  ])

  useEffect(() => {
    if (!expandedRoomAppId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setExpandedRoomAppId(null)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [expandedRoomAppId])

  useEffect(() => {
    if (expandedRoomAppId && expandedRoomAppId !== activeRoomAppId)
      setExpandedRoomAppId(null)
  }, [activeRoomAppId, expandedRoomAppId])

  const launchRoomApp = useCallback((appId: string) => {
    setLaunchedRoomAppIds((previous) =>
      previous.includes(appId)
        ? previous
        : [...previous, appId].slice(-ROOM_APP_MAX_INSTANCES)
    )
  }, [])

  /**
   * #98: opening an App is what makes it recent — switching to it, deep-linking
   * into it, or picking it in the launcher. Duplicates never accumulate: an App
   * that is already recent only moves to the front of a bounded list.
   */
  useEffect(() => {
    if (!activeRoomAppId || !availableRoomAppIds.has(activeRoomAppId)) return
    setRecentRoomAppIds((previous) =>
      pushRecentRoomAppId(previous, activeRoomAppId)
    )
  }, [activeRoomAppId, availableRoomAppIds])

  // Recency is remembered for this browser tab only, namespaced by Room name.
  // `sessionStorage` (never `localStorage`) keeps a reload inside the same Room
  // consistent without creating any cross-session or cross-device preference.
  useEffect(() => {
    if (roomName.length === 0) return
    writeRecentRoomAppIds(roomName, prunedRecentRoomAppIds)
  }, [prunedRecentRoomAppIds, roomName])

  // Rehydrate the tab's remembered Apps once this browser is bound to a Room;
  // server rendering and the first paint must not depend on storage.
  useEffect(() => {
    if (roomName.length === 0) return
    setRecentRoomAppIds((previous) =>
      previous.length > 0 ? previous : readRecentRoomAppIds(roomName)
    )
  }, [roomName])

  // A catalog refresh can retire an App that is still remembered, so the
  // remembered list is re-filtered against the current catalog rather than
  // trusted. Ordinary rendering already reads the pruned list, so this only
  // keeps the retained state (and the tab's stored order) from holding onto an
  // App the catalog no longer offers — it never touches resident host
  // lifecycle. The reference is preserved when nothing changed.
  useEffect(() => {
    setRecentRoomAppIds((previous) => {
      const next = pruneRecentRoomAppIds(previous, availableRoomAppIds)
      return next.length === previous.length &&
        next.every((id, index) => id === previous[index])
        ? previous
        : next
    })
  }, [availableRoomAppIds, prunedRecentRoomAppIds])

  const selectRoomApp = useCallback((appId: string) => {
    // Exactly the inline strip's behavior: hide fullscreen, launch (or reuse)
    // the resident host, and make it the current Stage App. The launcher's job
    // ends at selection — it never owns App lifecycle.
    setExpandedRoomAppId(null)
    setRoomAppsLauncherOpen(false)
    setLaunchedRoomAppIds((previous) =>
      previous.includes(appId)
        ? previous
        : [...previous, appId].slice(-ROOM_APP_MAX_INSTANCES)
    )
    setActiveRoomAppId(appId)
  }, [])

  const toggleRoomAppFullscreen = useCallback(
    (appId: string) => {
      if (activeRoomAppId !== appId) return
      setExpandedRoomAppId((current) => (current === appId ? null : appId))
    },
    [activeRoomAppId]
  )

  const hideRoomApp = useCallback((appId: string) => {
    setActiveRoomAppId((current) => (current === appId ? null : current))
    setExpandedRoomAppId((current) => (current === appId ? null : current))
  }, [])

  useEffect(() => {
    setReadyRoomAppIds((previous) => {
      const next = previous.filter((id) => launchedRoomAppIds.includes(id))
      return next.length === previous.length ? previous : next
    })
  }, [launchedRoomAppIds])

  useEffect(() => {
    if (
      initialRoomAppLaunchAttemptedRef.current ||
      !initialRoomAppId ||
      !roomAppsEnabled ||
      !roomAppCatalogLoaded
    )
      return
    if (!curatedRoomApps.some((app) => app.id === initialRoomAppId)) return
    initialRoomAppLaunchAttemptedRef.current = true
    launchRoomApp(initialRoomAppId)
    setActiveRoomAppId(initialRoomAppId)
  }, [
    curatedRoomApps,
    initialRoomAppId,
    launchRoomApp,
    loadedRoomAppCatalog,
    roomAppCatalogLoaded,
    roomAppsEnabled,
  ])

  const handleRoomAppReady = useCallback((appId: string) => {
    setReadyRoomAppIds((previous) =>
      previous.includes(appId) ? previous : [...previous, appId]
    )
    if (process.env.NODE_ENV !== "production") return
    // Only curated production Apps are reported; local dev fixtures and any
    // unallowlisted id stay out of analytics without a second allowlist.
    const productionAppId = resolveProductionRoomAppId(appId)
    if (productionAppId)
      trackAnalyticsEvent(
        "RoomAppMounted",
        withAcquisitionPage(
          { app: productionAppId },
          acquisitionPageRef.current
        )
      )
  }, [])

  const handleRoomAppEngaged = useCallback((appId: string) => {
    if (process.env.NODE_ENV !== "production") return
    const productionAppId = resolveProductionRoomAppId(appId)
    if (!productionAppId) return
    trackAnalyticsEvent(
      "RoomAppEngaged",
      withAcquisitionPage(
        {
          app: productionAppId,
          participantsBucket: participantsBucket(
            humanParticipantCountRef.current
          ),
        },
        acquisitionPageRef.current
      )
    )
  }, [])

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return
    if (!sharedSessionRoomAppId || humanParticipantCount < 2) return
    if (sharedSessionTrackedAppIdsRef.current.has(sharedSessionRoomAppId))
      return
    sharedSessionTrackedAppIdsRef.current.add(sharedSessionRoomAppId)
    trackAnalyticsEvent(
      "RoomAppSharedSession",
      withAcquisitionPage(
        {
          app: sharedSessionRoomAppId,
          participantsBucket: participantsBucket(humanParticipantCount),
        },
        acquisitionPage
      )
    )
  }, [acquisitionPage, humanParticipantCount, sharedSessionRoomAppId])

  const screenshareAllowed = resolvedRoomType === "screenshare"

  const handleStartTask = useCallback(
    (peerId: string, name: string) => {
      const participant = participants.find(
        (candidate) => candidate.peerId === peerId && candidate.kind === "agent"
      )
      if (!participant) return
      setTaskAgent({ peerId, name })
      setTaskInstruction("")
      setTaskError("")
    },
    [participants]
  )

  const closeTaskComposer = useCallback(() => {
    setTaskAgent(null)
    setTaskInstruction("")
    setTaskError("")
  }, [])

  const submitTask = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!taskAgent) return
      const sent = sendCollabRequest(taskAgent.peerId, taskInstruction)
      if (!sent) {
        setTaskError("Could not start the task. Check your connection.")
        return
      }
      pendingLocalTaskSummaries.current.push(taskInstruction.trim())
      closeTaskComposer()
    },
    [closeTaskComposer, sendCollabRequest, taskAgent, taskInstruction]
  )

  const toggleAgentVoice = useCallback(
    (participantId: string, enabled: boolean) => {
      setAgentVoice(participantId, enabled)
      trackAnalyticsEvent(enabled ? "AgentVoiceStarted" : "AgentVoiceStopped", {
        roomType: resolvedRoomType,
      })
    },
    [resolvedRoomType, setAgentVoice]
  )
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

  const showTaskLiveView = Boolean(
    activeTaskLiveView && (!activeShare || stageView === "live-view")
  )
  const activeSharePeerIdForStage = activeShare?.peerId
  useEffect(() => {
    setStageView(activeSharePeerIdForStage ? "screen" : "live-view")
  }, [activeSharePeerIdForStage, activeTask?.requestId])

  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const [splitRatio, setSplitRatio] = useState(50)
  // The launcher anchors to the Stage strip's `Apps…` control, never to the
  // strip itself: the strip is a horizontal scroller, so an in-flow popover
  // could be clipped by it.
  const roomAppsLauncherAnchorRef = useRef<HTMLDivElement | null>(null)
  const attachRoomAppsLauncherAnchor = useCallback(
    (element: HTMLDivElement | null) => {
      roomAppsLauncherAnchorRef.current = element
    },
    []
  )

  useEffect(() => {
    const check = () => setIsMd(window.innerWidth >= 768)
    check()
    window.addEventListener("resize", check)
    return () => window.removeEventListener("resize", check)
  }, [])

  useEffect(() => {
    // A Room App is a large visual surface like screen share, so it gets the
    // wide Stage rather than a conversation-sized pane.
    setSplitRatio(activeScreenShares.length > 0 || visibleRoomApp ? 75 : 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScreenShares.length > 0, Boolean(visibleRoomApp)])

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
      trackAnalyticsEvent(
        "RoomActivated",
        withAcquisitionPage(
          {
            roomType: resolvedRoomType,
            participantBucket: participantsBucket(participants.length),
            activationDelaySeconds: 30,
          },
          acquisitionPage
        )
      )
    }, 30_000)

    return () => window.clearTimeout(timeout)
  }, [acquisitionPage, connectionStatus, participants.length, resolvedRoomType])

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
  const wrappedSendText = useCallback(
    (text: string, targets: string[] = [], taskRequestId?: string) => {
      if (!hasSentTextRef.current) {
        hasSentTextRef.current = true
        umamiEvent("ChatActivity", {
          type: "text",
          roomHash: hashRoom(roomName),
        })
      }
      sendTextMessage(text, targets, taskRequestId)
    },
    [roomName, sendTextMessage]
  )

  // #363 review (point 1): the composer awaits this promise only until the
  // submission is ready to be released — the local DataChannel transfer has
  // genuinely begun and, when a bounded Agent-readable copy applies, that
  // bounded copy has been published. The full 20 MB transfer is never awaited;
  // the existing ephemeral "Sending…" timeline bubble keeps tracking it
  // exactly as before. A failed applicable copy rejects this promise so the
  // composer keeps a truthful draft instead of releasing the text.
  const wrappedSendFile = useCallback(
    async (file: File): Promise<void> => {
      const id = `${Date.now()}-${file.name}`
      if (file.size > MAX_FILE_SIZE)
        throw new Error("File exceeds the 20 MB limit")
      umamiEvent("ChatActivity", {
        type: file.type.startsWith("image/") ? "image" : "file",
        roomHash: hashRoom(roomName),
      })
      let markReady: (() => void) | undefined
      let markFailed: ((error: unknown) => void) | undefined
      const readiness = new Promise<void>((resolve, reject) => {
        markReady = resolve
        markFailed = reject
      })
      // The composer owns the pre-Send draft; this derived promise is not
      // always awaited by its caller, so keep the rejection handled.
      void readiness.catch(() => undefined)
      setPendingFiles((prev) => [
        ...prev,
        { id, fileName: file.name, isImage: file.type.startsWith("image/") },
      ])
      void sendFileMessage(file, {
        onReadiness: (error) => {
          if (error === undefined) markReady?.()
          else markFailed?.(error)
        },
      })
        .then(() => {
          setPendingFiles((prev) => prev.filter((f) => f.id !== id))
        })
        .catch((error) => {
          markFailed?.(error)
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
        })
      return readiness
    },
    [roomName, sendFileMessage]
  )

  // #363 A2: a Human attachment inside the ACTIVE Task rides the existing
  // bounded, task-correlated Room attachment API — never the 20 MB Room
  // DataChannel transfer — and never falls back to Room scope. The composer
  // owns the wake intent: an attachment-only submission wakes the Task Agent,
  // an attachment + text submission keeps the attachment as Task context so
  // the following text is the single addressed wake boundary.
  const activeTaskRequestId = activeTask?.requestId
  const wrappedSendTaskFile = useCallback(
    async (
      file: File,
      taskRequestId: string,
      wakeAgent: boolean
    ): Promise<void> => {
      if (!activeTaskRequestId || activeTaskRequestId !== taskRequestId)
        throw new Error("This task is no longer active")
      await sendTaskAttachment(file, taskRequestId, wakeAgent)
    },
    [activeTaskRequestId, sendTaskAttachment]
  )

  const selfScreenShareRef = useRef(false)
  const [screenShareWarning, setScreenShareWarning] = useState("")
  const wrappedToggleScreenShare = useCallback(() => {
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
  }, [participants, roomName, toggleScreenShare])

  const handleCollabRespond = useCallback(
    (requestId: string, decision: "accepted" | "declined") => {
      sendCollabResponse(requestId, decision)
    },
    [sendCollabResponse]
  )
  const handleReadArtifact = useCallback(
    (attachmentId: string) => readRoomAttachment(attachmentId),
    [readRoomAttachment]
  )
  const handleCollabResult = useCallback(
    (requestId: string, status: "completed" | "failed", summary: string) => {
      sendCollabResult(requestId, status, summary)
    },
    [sendCollabResult]
  )
  const handlePermissionResponse = useCallback(
    (requestId: string, selectedOptionId: string) => {
      sendPermissionResponse(requestId, selectedOptionId)
    },
    [sendPermissionResponse]
  )

  const copyInviteLink = async (appId?: string): Promise<boolean> => {
    if (typeof window === "undefined") return false
    const productionAppId =
      appId === undefined ? null : resolveProductionRoomAppId(appId)
    if (appId !== undefined && !productionAppId) return false
    const url = buildRoomInviteUrl({
      origin: window.location.origin,
      roomName,
      roomType: resolvedRoomType,
      appId: productionAppId,
    })
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      return false
    }
    trackAnalyticsEvent("InviteLinkCopied", {
      surface: productionAppId ? "room_app" : "room",
      roomType: resolvedRoomType,
      ...(productionAppId ? { app: productionAppId } : {}),
    })
    return true
  }

  const copyRoomLink = async () => {
    if (!(await copyInviteLink())) return
    setRoomLinkCopied(true)
    setTimeout(() => setRoomLinkCopied(false), 2000)
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
    <main
      className="room-shell flex h-screen flex-col overflow-hidden bg-gray-900 text-white"
      data-room-app-focus={isRoomAppFullscreen ? "true" : undefined}
    >
      {connectionStatus === "reconnecting" && (
        <div
          data-testid="room-reconnect-guard"
          role="alert"
          aria-live="assertive"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60"
        >
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-yellow-400" />
          <p className="text-sm text-gray-400">Reconnecting...</p>
        </div>
      )}

      <header
        className={`room-header ${
          isRoomAppFullscreen
            ? "hidden"
            : "flex flex-none flex-col gap-2 border-b border-gray-800 px-4 py-3 lg:flex-row lg:items-center"
        }`}
        hidden={isRoomAppFullscreen}
        aria-hidden={isRoomAppFullscreen}
        inert={isRoomAppFullscreen}
      >
        <div
          data-testid="room-header-identity"
          className="flex min-w-0 items-center gap-2"
        >
          <h1 className="min-w-0 flex-1 truncate text-lg font-medium lg:flex-none">
            #{roomName}
          </h1>
          <button
            type="button"
            onClick={() => {
              leaveRoom()
              router.push("/")
            }}
            className="room-header-leave shrink-0 rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 lg:hidden"
          >
            Leave
          </button>
        </div>
        <div
          data-testid="room-header-features"
          className="flex flex-none flex-col gap-2 lg:ml-auto lg:flex-row lg:items-center lg:gap-2"
        >
          <div className="room-header-toolbar grid grid-cols-3 gap-2 lg:flex lg:items-center">
            <button
              type="button"
              onClick={copyRoomLink}
              className="flex min-w-0 items-center justify-center gap-1 rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
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
              localParticipantId={effectiveLocalParticipantId}
              participants={participants}
              mediaAvailable={liveTranscriptMediaAvailable}
              onStart={handleStartLiveTranscript}
              onStop={handleStopLiveTranscript}
              onConnect={handleConnectRuntime}
              runtimeConnectionStatus={runtimeConnectionStatus}
              runtimeConnectError={runtimeConnectError}
              onSuggestInvite={() => setAgentInviteOpen(true)}
            />
            {/* #402: voice is opt-in and Room-owned — the canonical mic
                control lives in persistent Room chrome, never on a Stage
                surface, so it survives Room Apps / screen share / Live View. */}
            <RoomMicControl
              micState={localMicState}
              enabled={connectionStatus === "connected"}
              onToggle={toggleMicrophone}
              testId="room-mic-control"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              leaveRoom()
              router.push("/")
            }}
            className="room-header-leave hidden shrink-0 rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 lg:inline-flex"
          >
            Leave
          </button>
        </div>
      </header>

      {error !== "" && (
        <div
          className={`${
            isRoomAppFullscreen
              ? "hidden"
              : "flex flex-none items-center gap-4 bg-gray-900 px-4 py-2 text-white"
          }`}
          hidden={isRoomAppFullscreen}
          role="alert"
          aria-hidden={isRoomAppFullscreen}
          inert={isRoomAppFullscreen}
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
      <div
        className={isRoomAppFullscreen ? "hidden" : undefined}
        hidden={isRoomAppFullscreen}
        aria-hidden={isRoomAppFullscreen}
        inert={isRoomAppFullscreen}
      >
        <LiveTranscriptSegments segments={liveTranscriptSegments} />
      </div>
      {screenShareWarning !== "" && (
        <div
          className={`mx-4 mt-1 flex-none items-center gap-4 rounded border border-amber-700/50 bg-amber-900/40 px-4 py-2 text-amber-200 ${
            isRoomAppFullscreen ? "hidden" : "flex"
          }`}
          hidden={isRoomAppFullscreen}
          role="alert"
          aria-hidden={isRoomAppFullscreen}
          inert={isRoomAppFullscreen}
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

      {/* Room voice is ambient Room state: the remote playback sinks live for
          this whole Room session, outside every Stage/visibility conditional
          below, so opening, hiding or fullscreening a Room App (or switching
          to a screen share / Live View) can never stop remote audio. */}
      <RoomAudioSinks participants={participants} />

      <div
        ref={containerRef}
        className="room-content flex flex-1 flex-col overflow-hidden md:flex-row"
      >
        {/* Room App focus mode is an ordinary Room layout state, not a
            viewport-fixed overlay: every surrounding surface below is already
            hidden and inert, so the Stage simply takes the whole Room content
            region and the resident host fills it. A `position: fixed`
            descendant could not escape this split, `overflow-hidden` Stage on
            iPad Safari — it was clipped at the old Stage/chat boundary, taking
            the host's right-side chrome ("Exit fullscreen") with it. */}
        <div
          data-testid="room-stage"
          className="room-panel room-participants-panel flex flex-1 flex-col overflow-hidden border-b border-gray-800 md:flex-none md:border-b-0 md:border-r"
          style={
            isRoomAppFullscreen
              ? { width: "100%" }
              : isMd
              ? { width: `${splitRatio}%` }
              : undefined
          }
        >
          {/* #111: Agent workspace snapshots — observation only, available in
              every room type; Human screen share is untouched below. */}
          <div
            className={isRoomAppFullscreen ? "hidden" : undefined}
            hidden={isRoomAppFullscreen}
            aria-hidden={isRoomAppFullscreen}
            inert={isRoomAppFullscreen}
          >
            <WorkspaceSnapshots
              participants={participants}
              getLocalRoomAuth={getLocalRoomAuth}
            />
          </div>
          <div className="relative flex flex-1 flex-col overflow-hidden">
            {/* #98: the Stage entry is progressive disclosure, not the whole
                catalog. Room stays permanently reachable, at most a few
                recent/current Apps stay inline, and every promoted runtime
                remains one action away in the launcher. Stage selection stays
                independent from the conversation scope in the right pane. */}
            {(roomApps.length > 0 ||
              activeScreenShares.length > 0 ||
              Boolean(activeTaskLiveView)) && (
              <div
                role="tablist"
                aria-label="Stage"
                data-testid="stage-switcher"
                className={`scrollbar-thin z-10 flex-none gap-1 overflow-x-auto border-b border-gray-800 bg-gray-950/80 p-2 ${
                  isRoomAppFullscreen ? "hidden" : "flex"
                }`}
                hidden={isRoomAppFullscreen}
                aria-hidden={isRoomAppFullscreen}
                inert={isRoomAppFullscreen}
              >
                {inlineRoomApps.map((app) => {
                  const selected = activeRoomAppId === app.id
                  return (
                    <button
                      key={app.id}
                      type="button"
                      aria-pressed={selected}
                      data-testid={`stage-app-${app.id}`}
                      data-current-app={selected ? "true" : undefined}
                      title={app.label}
                      onClick={() => {
                        if (selected) {
                          // Hide, do not destroy: the resident host keeps its
                          // iframe, MessagePort and App-local state.
                          setExpandedRoomAppId(null)
                          setActiveRoomAppId(null)
                          return
                        }
                        selectRoomApp(app.id)
                      }}
                      className={`flex max-w-[9rem] shrink-0 items-center gap-1 rounded px-2 py-1 text-xs ${
                        selected
                          ? "bg-blue-600 text-white"
                          : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                      }`}
                    >
                      {/* A long Lab label must never break the Room layout: the
                          chip truncates and the full label stays in `title`. */}
                      <span
                        data-testid={`stage-app-label-${app.id}`}
                        className="truncate"
                      >
                        {app.label}
                      </span>
                      {/* The current App stays explicit even when its chip is
                          scrolled out of view or truncated. */}
                      {selected && (
                        <span
                          aria-hidden="true"
                          className="flex-none text-[10px]"
                        >
                          ●
                        </span>
                      )}
                    </button>
                  )
                })}
                {activeScreenShares.length > 0 && (
                  <button
                    type="button"
                    data-testid="stage-view-screen"
                    onClick={() => {
                      setRoomAppsLauncherOpen(false)
                      setExpandedRoomAppId(null)
                      setStageView("screen")
                      setActiveRoomAppId(null)
                    }}
                    aria-pressed={stageView === "screen" && !visibleRoomApp}
                    className={`shrink-0 rounded px-2 py-1 text-xs ${
                      stageView === "screen" && !visibleRoomApp
                        ? "bg-blue-600 text-white"
                        : "text-gray-400 hover:bg-gray-800"
                    }`}
                  >
                    Screen
                  </button>
                )}
                {activeTaskLiveView && (
                  <button
                    type="button"
                    data-testid="stage-view-live-view"
                    onClick={() => {
                      setRoomAppsLauncherOpen(false)
                      setExpandedRoomAppId(null)
                      setStageView("live-view")
                      setActiveRoomAppId(null)
                    }}
                    aria-pressed={stageView === "live-view" && !visibleRoomApp}
                    className={`shrink-0 rounded px-2 py-1 text-xs ${
                      stageView === "live-view" && !visibleRoomApp
                        ? "bg-blue-600 text-white"
                        : "text-gray-400 hover:bg-gray-800"
                    }`}
                  >
                    Live View
                  </button>
                )}
                {roomApps.length > 0 && (
                  <div
                    ref={attachRoomAppsLauncherAnchor}
                    className="relative flex shrink-0 items-center"
                  >
                    <button
                      type="button"
                      data-testid="stage-apps-launcher"
                      aria-haspopup="dialog"
                      aria-expanded={roomAppsLauncherOpen}
                      title="Search all Room Apps"
                      onClick={() => setRoomAppsLauncherOpen((open) => !open)}
                      className={`rounded px-2 py-1 text-xs ${
                        roomAppsLauncherOpen
                          ? "bg-gray-800 text-gray-200"
                          : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                      }`}
                    >
                      Apps…
                    </button>
                    {roomAppsLauncherOpen && (
                      <RoomAppLauncher
                        apps={roomApps}
                        recentAppIds={prunedRecentRoomAppIds}
                        activeAppId={activeRoomAppId}
                        onSelect={selectRoomApp}
                        onClose={() => setRoomAppsLauncherOpen(false)}
                        isDesktop={isMd}
                        anchorRef={roomAppsLauncherAnchorRef}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Resident App hosts: every launched App stays mounted for this
                browser Room session. Stage navigation only toggles visibility,
                so hiding one never destroys its iframe or MessagePort. Hidden
                slots are display:none + inert + aria-hidden, which keeps them
                out of hit-testing, focus and the accessibility tree while they
                keep receiving the bounded App messages. */}
            {roomAppSelf &&
              residentRoomApps.map((app) => {
                const productionAppId = resolveProductionRoomAppId(app.id)
                const isFullscreen =
                  expandedRoomAppId === app.id && activeRoomAppId === app.id
                const visible = visibleRoomApp?.id === app.id || isFullscreen
                const reconnectBlocked =
                  isFullscreen && connectionStatus === "reconnecting"
                return (
                  <div
                    key={app.id}
                    data-testid={`room-app-slot-${app.id}`}
                    aria-hidden={!visible || reconnectBlocked}
                    inert={!visible || reconnectBlocked}
                    className={
                      visible ? "flex min-h-0 flex-1 flex-col" : "hidden"
                    }
                  >
                    <RoomAppHost
                      app={app}
                      appInstanceId={roomAppInstanceId(roomName, app.id)}
                      self={roomAppSelf}
                      participants={roomAppParticipants}
                      subscribe={subscribeRoomAppMessages}
                      send={sendRoomAppMessage}
                      onReady={handleRoomAppReady}
                      onEngaged={handleRoomAppEngaged}
                      subscribeUnicast={subscribeRoomAppUnicast}
                      subscribeUnicastResults={subscribeRoomAppUnicastResults}
                      sendUnicast={sendRoomAppUnicast}
                      isFullscreen={isFullscreen}
                      onToggleFullscreen={() => toggleRoomAppFullscreen(app.id)}
                      onInvite={
                        productionAppId
                          ? () => copyInviteLink(productionAppId)
                          : undefined
                      }
                      onClose={() => hideRoomApp(app.id)}
                      onUnavailable={hideRoomApp}
                    />
                  </div>
                )
              })}
            {/* #402 fullscreen safety surface: focus mode intentionally hides
                the ordinary Room header, so a minimal Room-owned mic control
                stays reachable without closing the App or reloading. It is
                chrome outside the iframe, owned by RoomContent, and reuses the
                same state as the header control. */}
            {isRoomAppFullscreen && roomAppSelf && (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-start p-2"
                style={{
                  paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))",
                }}
              >
                <RoomMicControl
                  micState={localMicState}
                  enabled={connectionStatus === "connected"}
                  onToggle={toggleMicrophone}
                  testId="room-mic-control-fullscreen"
                  fullscreen
                />
              </div>
            )}
            {!visibleRoomApp &&
              !isRoomAppFullscreen &&
              (activeScreenShares.length > 0 ? (
                <>
                  <div
                    className={
                      showTaskLiveView ? "hidden" : "flex min-h-0 flex-1"
                    }
                  >
                    {activeShare && (
                      <ScreenShareViewer
                        key={activeShare.peerId}
                        stream={activeShare.screenShareStream!}
                        name={activeShare.name}
                      />
                    )}
                  </div>
                  {showTaskLiveView && activeTaskLiveView && (
                    <TaskLiveView
                      key={activeTask!.requestId}
                      snapshot={activeTaskLiveView}
                      stateStore={taskLiveViewState}
                      onVisible={handleLiveViewVisible}
                      onInteract={handleLiveViewInteracted}
                    />
                  )}
                  <div className="room-participant-strip scrollbar-thin flex flex-none flex-row gap-2 overflow-x-auto border-t border-gray-800 p-2">
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
                          onMuteSelf={toggleMicrophone}
                          micState={localMicState}
                          onToggleScreenShare={wrappedToggleScreenShare}
                          screenshareAllowed={screenshareAllowed}
                          voiceAvailable={
                            p.voiceAvailable && agentVoiceMediaAvailable
                          }
                          voiceEnabled={p.voiceEnabled}
                          onToggleAgentVoice={toggleAgentVoice}
                          onStartTask={handleStartTask}
                          className="w-[84px]"
                          compact
                        />
                      </div>
                    ))}
                  </div>
                </>
              ) : showTaskLiveView && activeTaskLiveView ? (
                <TaskLiveView
                  key={activeTask!.requestId}
                  snapshot={activeTaskLiveView}
                  stateStore={taskLiveViewState}
                  onVisible={handleLiveViewVisible}
                  onInteract={handleLiveViewInteracted}
                />
              ) : (
                <div
                  data-testid="room-stage-participants"
                  className="room-participants-grid scrollbar-thin flex h-full flex-wrap content-start items-start justify-center gap-2 overflow-y-auto p-3"
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
                        onMuteSelf={toggleMicrophone}
                        micState={localMicState}
                        onToggleScreenShare={wrappedToggleScreenShare}
                        voiceAvailable={
                          p.voiceAvailable && agentVoiceMediaAvailable
                        }
                        voiceEnabled={p.voiceEnabled}
                        onToggleAgentVoice={toggleAgentVoice}
                        onStartTask={handleStartTask}
                        screenshareAllowed={screenshareAllowed}
                        className="w-40 flex-none"
                      />
                    </div>
                  ))}
                </div>
              ))}

            {!isRoomAppFullscreen &&
              floatingReactions.map((r) => (
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
          className={`w-1 cursor-col-resize bg-gray-800 transition-colors hover:bg-blue-500/50 active:bg-blue-500 ${
            isRoomAppFullscreen ? "hidden" : "hidden md:block"
          }`}
          hidden={isRoomAppFullscreen}
          aria-hidden={isRoomAppFullscreen}
          inert={isRoomAppFullscreen}
          onMouseDown={(e) => {
            isDragging.current = true
            e.preventDefault()
          }}
        />

        <div
          className={`room-panel room-chat-panel ${
            isRoomAppFullscreen
              ? "hidden"
              : "flex flex-1 flex-col overflow-hidden"
          }`}
          hidden={isRoomAppFullscreen}
          aria-hidden={isRoomAppFullscreen}
          inert={isRoomAppFullscreen}
        >
          <div
            role="tablist"
            aria-label="Room interactions"
            data-testid="interaction-tablist"
            className="scrollbar-thin flex flex-none gap-1 overflow-x-auto border-b border-gray-800 bg-gray-950/60 px-3 py-2"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeInteraction === "room"}
              data-testid="interaction-tab-room"
              onClick={() => setActiveInteraction("room")}
              className={`shrink-0 rounded-md px-3 py-1.5 text-xs transition ${
                activeInteraction === "room"
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              Room
            </button>
            {taskProjections.map((task) => (
              <button
                key={task.requestId}
                type="button"
                role="tab"
                aria-selected={activeInteraction === task.requestId}
                data-testid={`interaction-tab-task-${task.requestId}`}
                onClick={() => setActiveInteraction(task.requestId)}
                title={
                  taskIsUnavailable(task, participants)
                    ? `${task.title} — unavailable`
                    : task.title
                }
                className={`flex max-w-52 shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition ${
                  activeInteraction === task.requestId
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span
                  aria-label={`Status ${task.status}`}
                  className="text-[10px] opacity-70"
                >
                  {task.status === "Completed"
                    ? "✓"
                    : task.status === "Failed"
                    ? "×"
                    : "●"}
                </span>
                {taskIsUnavailable(task, participants) && (
                  <span
                    aria-label="Task unavailable"
                    className="text-[10px] text-amber-300"
                  >
                    !
                  </span>
                )}
              </button>
            ))}
          </div>
          <div
            data-testid="interaction-content"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {activeTaskActivities.length > 0 && (
              <div
                data-testid="task-agent-activity"
                className="flex flex-none flex-wrap gap-x-3 gap-y-1 border-b border-gray-800 bg-gray-950/40 px-3 py-1.5 text-xs text-blue-200/80"
              >
                {activeTaskActivities.map((activity) => {
                  const participant = participants.find(
                    (candidate) =>
                      candidate.peerId === activity.agentParticipantId
                  )
                  return (
                    <span key={activity.agentParticipantId}>
                      {participant?.name ?? "Agent"} ·{" "}
                      {agentActivityLabel(activity.state)}…
                    </span>
                  )
                })}
              </div>
            )}
            {/* The conversation pane always renders the selected Room/Task
                conversation; an active Room App lives on the Stage instead. */}
            <div data-testid="interaction-chat" className="min-h-0 flex-1">
              <TextChatCard
                key={activeInteraction}
                room={roomName}
                nickName={nickName}
                messages={interactionMessages}
                attachments={interactionAttachments}
                participants={participants}
                pendingFiles={activeTask ? [] : pendingFiles}
                onSendText={wrappedSendText}
                onSendFile={wrappedSendFile}
                onSendTaskFile={wrappedSendTaskFile}
                onSendAction={sendActionMessage}
                localParticipantId={effectiveLocalParticipantId}
                onCollabRespond={handleCollabRespond}
                onReadArtifact={handleReadArtifact}
                onCollabResult={handleCollabResult}
                onPermissionRespond={handlePermissionResponse}
                taskAvailable={!activeTaskUnavailable}
                taskRequestId={activeTask?.requestId}
              />
            </div>
          </div>
        </div>
      </div>
      {taskAgent && (
        <div
          className={`fixed inset-0 z-40 bg-black/60 px-4 ${
            isRoomAppFullscreen ? "hidden" : "flex items-center justify-center"
          }`}
          hidden={isRoomAppFullscreen}
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-task-title"
          aria-hidden={isRoomAppFullscreen}
          inert={isRoomAppFullscreen}
        >
          <form
            onSubmit={submitTask}
            className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-5 shadow-2xl"
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 id="start-task-title" className="text-base font-semibold">
                  Start task with {taskAgent.name}
                </h2>
                <p className="mt-1 text-xs text-gray-400">
                  Give this Agent one thing to work on.
                </p>
              </div>
              <button
                type="button"
                onClick={closeTaskComposer}
                className="text-gray-400 hover:text-white"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <label
              htmlFor="start-task-instruction"
              className="mb-2 block text-sm text-gray-200"
            >
              What should this Agent do?
            </label>
            <textarea
              id="start-task-instruction"
              value={taskInstruction}
              onChange={(event) => setTaskInstruction(event.target.value)}
              maxLength={MAX_COLLAB_SUMMARY_LENGTH}
              rows={4}
              autoFocus
              className="w-full resize-none rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400"
            />
            {taskError && (
              <p role="alert" className="mt-2 text-xs text-rose-300">
                {taskError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeTaskComposer}
                className="rounded-md border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!taskInstruction.trim()}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}
