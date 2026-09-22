import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"

import { useRouter } from "next/router"

import { LOCAL_PEER_ID } from "@common/consts"
import { MAX_COLLAB_SUMMARY_LENGTH } from "@do/collab"
import {
  appendDedupedTaskSessions,
  taskSessionErrorMessage,
  type RelayTaskSession,
  type RelayTaskSessionProject,
} from "@do/taskSession"

import AgentInviteControl from "./AgentInviteControl"
import { LiveTranscriptControl, LiveTranscriptSegments } from "./LiveTranscript"
import RoomAppHost from "./RoomAppHost"
import RoomAppLauncher from "./RoomAppLauncher"
import RoomAudioSinks from "./RoomAudioSinks"
import TaskLiveView from "./TaskLiveView"
import TaskSessionPicker from "./TaskSessionPicker"
import TextChatCard from "./TextChatCard"
import UserCard from "./UserCard"
import WorkspaceSnapshots from "./WorkspaceSnapshots"
import { agentActivityLabel } from "../common/agentActivity"
import { buildAgentInvitePrompt } from "../common/agentInvite"
import {
  generatedRoomAppSrcDoc,
  type GeneratedRoomAppDocument,
  type GeneratedRoomAppPublication,
} from "../common/generatedRoomApp"
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
  ROOM_APP_INLINE_SHORTCUTS_DESKTOP,
  ROOM_APP_INLINE_SHORTCUTS_MOBILE,
  writeRecentRoomAppIds,
} from "../common/roomAppRecents"
import { taskExecutionLabel } from "../common/taskExecution"
import {
  isLargeTaskPaste,
  taskBriefLabel,
  taskPasteAttachment,
  taskPasteFitsAttachment,
  TASK_BRIEF_DEFAULT_LABEL,
} from "../common/taskPaste"
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
import type { TaskExecutionProjection } from "../room/types"

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

function selectAuthoritativeTaskExecution(
  taskRequestId: string,
  executions: TaskExecutionProjection[]
): { execution?: TaskExecutionProjection; ambiguous: boolean } {
  const matching = executions.filter(
    (execution) => execution.taskRequestId === taskRequestId
  )
  const active = matching.filter(
    (execution) => execution.currentTurnSequence !== undefined
  )
  // A unique active turn wins over retained terminal projections. Multiple
  // active turns remain visible as truth, but cannot authorize a singular
  // interrupt control.
  if (active.length === 1) return { execution: active[0], ambiguous: false }
  if (active.length > 1) return { ambiguous: true }
  // With no active turn, render a status only when there's one candidate.
  // Never choose among multiple inactive lanes by array order.
  return matching.length === 1
    ? { execution: matching[0], ambiguous: false }
    : { ambiguous: false }
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
  // #421: a large Start Task paste becomes a Task-correlated brief attachment
  // instead of textarea content, so the exact document reaches the Agent's
  // first turn instead of being silently truncated by the composer bound.
  const [taskBrief, setTaskBrief] = useState<File | null>(null)
  const [taskBriefNotice, setTaskBriefNotice] = useState("")
  // The EXACT pasted document, kept only so a bounded Task label can be
  // derived from it. It never leaves the composer as text: the attachment is
  // the only carrier of the brief.
  const taskBriefText = useRef("")
  const [taskError, setTaskError] = useState("")
  // #409 Task Session Continuation. The DEFAULT is always `new`: the Human
  // explicitly chooses "Continue session" and then explicitly chooses ONE
  // session, because resuming the wrong conversation is worse than one extra
  // click. Discovery is LAZY — opening this modal exports nothing.
  const [taskSessionMode, setTaskSessionMode] = useState<"new" | "continue">(
    "new"
  )
  const [taskSessionStatus, setTaskSessionStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle")
  const [taskSessions, setTaskSessions] = useState<RelayTaskSession[]>([])
  const [taskSessionProjects, setTaskSessionProjects] = useState<
    RelayTaskSessionProject[]
  >([])
  const [taskSessionPageToken, setTaskSessionPageToken] = useState<
    string | undefined
  >(undefined)
  const [taskSessionHasMore, setTaskSessionHasMore] = useState(false)
  const [taskSessionLoadingMore, setTaskSessionLoadingMore] = useState(false)
  const [taskSessionProjectToken, setTaskSessionProjectToken] = useState<
    string | null
  >(null)
  const [taskSessionSelection, setTaskSessionSelection] =
    useState<RelayTaskSession | null>(null)
  const [taskSessionError, setTaskSessionError] = useState("")
  // A start is in flight: the modal must not close optimistically, because a
  // failed preparation creates NO Task at all.
  const [taskStarting, setTaskStarting] = useState(false)
  // Monotonic guard so a late discovery response for a superseded view can
  // never repopulate the picker.
  const taskSessionRequestSeq = useRef(0)
  // Mirrors `taskSessions` so an async failure can decide truthfully whether
  // rows are already on screen without reading state inside an updater.
  const taskSessionsRef = useRef<RelayTaskSession[]>([])
  // #409: the only Interrupt UI state is the local send failure of the last
  // click. There is deliberately no persisted "Interrupted" Task state.
  const [taskInterruptFailed, setTaskInterruptFailed] = useState(false)
  const [activeInteraction, setActiveInteraction] = useState("room")
  const [activeRoomAppId, setActiveRoomAppId] = useState<string | null>(null)
  const [activeGeneratedAppId, setActiveGeneratedAppId] = useState<
    string | null
  >(null)
  const [generatedAppDocuments, setGeneratedAppDocuments] = useState<
    Record<string, GeneratedRoomAppDocument>
  >({})
  const [generatedAppLoading, setGeneratedAppLoading] = useState<string | null>(
    null
  )
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
  // Which Room the recency above has been READ for. Undefined until storage has
  // been read for the current Room, and that guard is load-bearing: persisting
  // the initial `[]` would delete the tab's remembered Apps before they were
  // ever read back, so no recency write or prune may happen until this matches
  // `roomName`. The read itself stays in an effect, never in render, so server
  // rendering and the first paint never depend on browser storage.
  const [recentsHydratedRoom, setRecentsHydratedRoom] = useState<
    string | undefined
  >(undefined)
  const [roomAppsLauncherOpen, setRoomAppsLauncherOpen] = useState(false)
  // Phone composition keeps ONE mounted participant/Stage panel. A first
  // ordinary mobile entry opens it so people and voice presence lead; explicit
  // Room chat or Task selection closes it and gives interaction the viewport.
  const [mobileRoomSheetOpen, setMobileRoomSheetOpen] = useState(false)
  const mobileSurfaceInitialized = useRef(false)
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
    generatedApps = {},
    sendTextMessage,
    sendFileMessage,
    sendTaskAttachment,
    sendActionMessage,
    sendCollabRequest,
    startTaskWithBrief,
    requestTaskSessions,
    startTaskWithSession,
    sendCollabResponse,
    readRoomAttachment,
    sendCollabResult,
    sendPermissionResponse,
    sendTaskInterrupt,
    sendTaskInterruptAndSend,
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
    taskExecutions,
    taskControlNotice,
    taskControlNoticeTaskRequestId,
    taskLocalError,
    roomAppsEnabled,
    sendRoomAppMessage,
    subscribeRoomAppMessages,
    sendRoomAppUnicast,
    subscribeRoomAppUnicast,
    subscribeRoomAppUnicastResults,
    sendGeneratedAppState,
    subscribeGeneratedAppState = () => () => undefined,
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
  // Retired Apps are forgotten only against a catalog this Room can actually
  // offer. The browser catalog loads asynchronously AND its enablement flag
  // drops during an ordinary media reconnect, so an empty `availableRoomAppIds`
  // must never be read as "every remembered App was retired" — that erased
  // recency across a reload and across reconnects. While Apps are not currently
  // offered, the retained list is used verbatim.
  const roomAppsAvailable = roomAppsEnabled && roomAppCatalogLoaded
  const prunedRecentRoomAppIds = useMemo(
    () =>
      roomAppsAvailable
        ? pruneRecentRoomAppIds(recentRoomAppIds, availableRoomAppIds)
        : recentRoomAppIds,
    [availableRoomAppIds, recentRoomAppIds, roomAppsAvailable]
  )
  const inlineRoomApps = useMemo(() => {
    const ids = inlineRoomAppIds(
      prunedRecentRoomAppIds,
      activeRoomAppId,
      availableRoomAppIds,
      isMd
        ? ROOM_APP_INLINE_SHORTCUTS_DESKTOP
        : ROOM_APP_INLINE_SHORTCUTS_MOBILE
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
  const activeTaskGeneratedApp = activeTask
    ? Object.values(generatedApps).find(
        (publication) => publication.taskRequestId === activeTask.requestId
      )
    : undefined
  const visibleGeneratedRoomApp = activeGeneratedAppId
    ? generatedAppDocuments[activeGeneratedAppId]
    : undefined
  const stageAppVisible = Boolean(visibleRoomApp || visibleGeneratedRoomApp)

  const openGeneratedApp = useCallback(
    async (publication: GeneratedRoomAppPublication) => {
      setActiveRoomAppId(null)
      setActiveGeneratedAppId(publication.appInstanceId)
      setStageView("screen")
      if (generatedAppDocuments[publication.appInstanceId]) return
      const auth = getLocalRoomAuth()
      if (!auth) return
      setGeneratedAppLoading(publication.appInstanceId)
      try {
        const response = await fetch(
          `/api/room/generated-app?appInstanceId=${encodeURIComponent(
            publication.appInstanceId
          )}`,
          {
            headers: {
              "X-Room-Id": auth.roomId,
              "X-Room-Participant-Id": auth.participantId,
              "X-Room-Participant-Token": auth.token,
            },
          }
        )
        if (!response.ok) throw new Error("generated_app_unavailable")
        const document = (await response.json()) as GeneratedRoomAppDocument
        setGeneratedAppDocuments((previous) => ({
          ...previous,
          [publication.appInstanceId]: document,
        }))
      } catch {
        setActiveGeneratedAppId(null)
      } finally {
        setGeneratedAppLoading(null)
      }
    },
    [generatedAppDocuments, getLocalRoomAuth]
  )
  useEffect(
    () =>
      subscribeGeneratedAppState((message) => {
        setGeneratedAppDocuments((previous) => {
          const document = previous[message.appInstanceId]
          if (!document) return previous
          return {
            ...previous,
            [message.appInstanceId]: {
              ...document,
              publication: {
                ...document.publication,
                stateRevision: message.revision,
              },
              state: message.state,
            },
          }
        })
      }),
    [subscribeGeneratedAppState]
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
  // A Task with no connected participant may still be deliberately handed off
  // to another connected Agent. Keep that narrow, explicit @-selection path
  // reachable; the Room continues to reject an unaddressed follow-up because
  // it never infers a replacement target.
  const activeTaskCanAdoptReplacement = Boolean(
    activeTaskUnavailable &&
      participants.some((participant) => participant.kind === "agent")
  )
  // #409/#421: the interrupt targets the Room's current accepted executor of
  // the selected Task and only the exact turn that executor's AUTHORITATIVE
  // execution projection currently reports. Presentation-only AgentActivity
  // must never produce this control.
  //
  // It is deliberately NOT gated on this Human having created the Task.
  // Free4Chat is an anonymous temporary Room: the Human who started a Task may
  // leave for longer than the reconnect grace and return as a NEW participant
  // id, and supervision of an existing canonical Task is Room-shared — the
  // same boundary that already lets any current Human send a Task follow-up or
  // resolve the Task's permission request. The Room (not this control)
  // enforces that the caller is a current authenticated Human and that the
  // turn is exactly the live one.
  // #409: per-Agent Runtime execution remains authoritative. A unique active
  // turn selects the executor; multiple active turns stay ambiguous and cannot
  // expose a singular interrupt target.
  const taskExecutionSelection = activeTask
    ? selectAuthoritativeTaskExecution(
        activeTask.requestId,
        taskExecutions ?? []
      )
    : { ambiguous: false }
  const activeTaskExecution = taskExecutionSelection.execution
  const activeTaskExecutionAmbiguous = taskExecutionSelection.ambiguous
  const activeTaskExecutionLabel = activeTaskExecution
    ? taskExecutionLabel(activeTaskExecution)
    : undefined
  const activeTaskLocalError =
    activeTask && taskLocalError?.taskRequestId === activeTask.requestId
      ? taskLocalError.message
      : ""
  const activeTaskControlNotice =
    activeTask &&
    taskControlNotice &&
    (taskControlNoticeTaskRequestId === undefined ||
      taskControlNoticeTaskRequestId === activeTask.requestId)
      ? taskControlNotice
      : ""
  const activeTaskInterrupting =
    activeTaskExecution?.phase === "interrupting" &&
    activeTaskExecution.currentTurnSequence !== undefined
  // #421 Fix C: AgentActivity is PRESENTATION ONLY. It supplies the coarse
  // verb ("Using tools…"), and it can be missing or stale after a Room
  // hibernation or reconciliation — neither of which may make a genuinely
  // running Task uncontrollable. The exact interrupt turn comes from the
  // authoritative execution projection above, never from this value.
  // The exact turn this Human may interrupt right now, or undefined when the
  // authoritative projection reports no current turn.
  const activeTaskTurn = activeTaskExecution?.currentTurnSequence

  // Phone signal line: ONE bounded, truncated sentence that tells a narrow
  // screen how many participants are here and what the active Agent is doing.
  // It reuses exactly the projections the desktop activity strip already
  // renders — the active Task's coarse AgentActivity first (the same verb the
  // `task-agent-activity` strip shows), the authoritative Task execution label
  // (#421 Fix C) when no AgentActivity survives, and the Room-scope
  // AgentActivity when no Task is selected. Presentation only: it never derives
  // queueing or "running" state of its own, and it is deliberately bounded to
  // labels (never the execution detail) so it stays one short line. Like every
  // projection it reads, it is a plain per-render derivation.
  const mobileRoomSignal = (() => {
    // `participants` is the hook's connected-participant projection
    // (buildParticipants is the single source of truth), so its length is the
    // connected count the participant grid already shows.
    const connectedCount = participants.length
    const parts = [
      `${connectedCount} participant${connectedCount === 1 ? "" : "s"}`,
    ]
    const taskActivity = activeTaskActivities[0]
    const roomActivity = activeTask
      ? undefined
      : (agentActivities ?? []).find(
          (activity) =>
            activity.scopeId === "room" &&
            participants.some(
              (participant) =>
                participant.peerId === activity.agentParticipantId &&
                participant.kind === "agent"
            )
        )
    const activity = activeTask ? taskActivity : roomActivity
    const state = activity
      ? `${agentActivityLabel(activity.state)}…`
      : activeTask
      ? activeTaskExecutionLabel?.label ?? ""
      : ""
    if (state === "") return parts.join(" · ")
    const agentParticipantId =
      activity?.agentParticipantId ??
      (activeTask ? activeTask.targetParticipantId : undefined)
    // The desktop strip's own bounded fallback, so a Task whose Agent already
    // left still reads as an Agent rather than leaking an internal id.
    const agentName = participants.find(
      (participant) => participant.peerId === agentParticipantId
    )?.name
    parts.push(agentName ?? "Agent", state)
    return parts.join(" · ")
  })()

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
    // A send-failure notice belongs to the Task it was raised for; switching
    // Tasks or leaving the Task must not carry it over.
    setTaskInterruptFailed(false)
  }, [activeInteraction])

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

  // True once THIS Room's recency has been read from browser storage. Nothing
  // may write, prune, or reorder recency before that.
  const recentsLoadedForRoom =
    roomName.length > 0 && recentsHydratedRoom === roomName

  /**
   * #98: opening an App is what makes it recent — switching to it, deep-linking
   * into it, or picking it in the launcher. Duplicates never accumulate: an App
   * that is already recent only moves to the front of a bounded list. It also
   * waits for this Room's recency to be read, so a deep-linked App cannot be
   * reordered against a list that has not loaded yet.
   */
  useEffect(() => {
    if (!recentsLoadedForRoom) return
    if (!activeRoomAppId || !availableRoomAppIds.has(activeRoomAppId)) return
    setRecentRoomAppIds((previous) =>
      pushRecentRoomAppId(previous, activeRoomAppId)
    )
  }, [activeRoomAppId, availableRoomAppIds, recentsLoadedForRoom])

  // Recency is hydrated BEFORE anything can persist or prune it, and the order
  // of these three effects is the contract:
  //
  //   1. read this Room's remembered Apps and mark this Room hydrated;
  //   2. prune the retained list against the CURRENT catalog;
  //   3. persist.
  //
  // Two separate guards make that contract real:
  //   - an earlier revision persisted first, so a fresh mount wrote the empty
  //     initial state, deleted the sessionStorage entry, and then rehydrated
  //     from the key it had just cleared — recents never survived a reload;
  //   - the catalog loads asynchronously, so pruning/persisting before it is
  //     authoritative would treat every remembered App as "retired" and erase
  //     them. Until the catalog has loaded, the remembered list is kept as-is.
  useEffect(() => {
    if (roomName.length === 0) return
    setRecentRoomAppIds(readRecentRoomAppIds(roomName))
    setRecentsHydratedRoom(roomName)
  }, [roomName])

  // Prune and persist are deliberately ONE effect. Splitting them created a
  // window where the persist effect still saw the previous render's derived
  // list, so a reload could write "nothing is recent" for one commit and erase
  // the tab's history. Here the value that is written is re-derived from state
  // in the same effect that writes it, so no stale prune can ever be persisted.
  //
  // A catalog refresh can retire an App that is still remembered, so the
  // retained list is re-filtered against the current catalog rather than
  // trusted. This only keeps the retained state (and the tab's stored order)
  // from holding onto an App the catalog no longer offers — it never touches
  // resident host lifecycle, and writes only once this Room has been hydrated
  // and the catalog has loaded.
  useEffect(() => {
    if (!recentsLoadedForRoom || !roomAppsAvailable) return
    setRecentRoomAppIds((previous) => {
      const next = pruneRecentRoomAppIds(previous, availableRoomAppIds)
      return next.length === previous.length &&
        next.every((id, index) => id === previous[index])
        ? previous
        : next
    })
    writeRecentRoomAppIds(
      roomName,
      pruneRecentRoomAppIds(recentRoomAppIds, availableRoomAppIds)
    )
  }, [
    availableRoomAppIds,
    recentRoomAppIds,
    recentsLoadedForRoom,
    roomAppsAvailable,
    roomName,
  ])

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
    if (productionAppId) {
      trackAnalyticsEvent(
        "RoomAppMounted",
        withAcquisitionPage(
          { app: productionAppId },
          acquisitionPageRef.current
        )
      )
    } else if (appId.startsWith("generated:")) {
      trackAnalyticsEvent(
        "RoomAppMounted",
        withAcquisitionPage(
          { appSource: "generated" },
          acquisitionPageRef.current
        )
      )
    }
  }, [])

  const handleRoomAppEngaged = useCallback((appId: string) => {
    if (process.env.NODE_ENV !== "production") return
    const productionAppId = resolveProductionRoomAppId(appId)
    if (!productionAppId && !appId.startsWith("generated:")) return
    trackAnalyticsEvent(
      "RoomAppEngaged",
      withAcquisitionPage(
        {
          ...(productionAppId
            ? { app: productionAppId }
            : { appSource: "generated" }),
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

  // #409: whether THIS Agent's resident Runtime advertised Task Session
  // Continuation. It is read from the additive Runtime feature projection, so
  // an older Runtime (agent-v0.5.34) simply never sets it and the modal stays
  // exactly as it is today.
  const taskAgentContinuation = useMemo(() => {
    if (!taskAgent) return false
    const participant = participants.find(
      (candidate) => candidate.peerId === taskAgent.peerId
    )
    return participant?.taskSessionContinuation === true
  }, [participants, taskAgent])

  const resetTaskSessionPicker = useCallback(() => {
    taskSessionRequestSeq.current += 1
    setTaskSessionMode("new")
    setTaskSessionStatus("idle")
    taskSessionsRef.current = []
    setTaskSessions([])
    setTaskSessionProjects([])
    setTaskSessionPageToken(undefined)
    setTaskSessionHasMore(false)
    setTaskSessionLoadingMore(false)
    setTaskSessionProjectToken(null)
    setTaskSessionSelection(null)
    setTaskSessionError("")
    setTaskStarting(false)
  }, [])

  const handleStartTask = useCallback(
    (peerId: string, name: string) => {
      const participant = participants.find(
        (candidate) => candidate.peerId === peerId && candidate.kind === "agent"
      )
      if (!participant) return
      resetTaskSessionPicker()
      setTaskAgent({ peerId, name })
      setTaskInstruction("")
      setTaskError("")
    },
    [participants, resetTaskSessionPicker]
  )

  const closeTaskComposer = useCallback(() => {
    // A start in flight must not be abandoned half-way: the Human either sees
    // its result or explicitly waits for it.
    if (taskStarting) return
    resetTaskSessionPicker()
    setTaskAgent(null)
    setTaskInstruction("")
    setTaskBrief(null)
    setTaskBriefNotice("")
    setTaskError("")
  }, [resetTaskSessionPicker, taskStarting])

  /**
   * #409: one bounded discovery page for the CURRENT picker view. Called
   * lazily on "Continue session", on a project change, and on Load more —
   * never on modal open, never on a timer, and never in a background refresh.
   */
  const loadTaskSessions = useCallback(
    async (
      targetAgentId: string,
      options: {
        projectToken?: string
        pageToken?: string
        append: boolean
      }
    ) => {
      const seq = ++taskSessionRequestSeq.current
      if (!options.append) {
        setTaskSessionStatus("loading")
        setTaskSessionError("")
      } else {
        setTaskSessionLoadingMore(true)
      }
      const result = await requestTaskSessions(targetAgentId, {
        ...(options.projectToken ? { projectToken: options.projectToken } : {}),
        ...(options.pageToken ? { pageToken: options.pageToken } : {}),
      })
      // A superseded view (modal closed, project switched) never repopulates.
      if (seq !== taskSessionRequestSeq.current) return
      setTaskSessionLoadingMore(false)
      if (result.ok === false) {
        if (options.append) {
          // A failed Load more keeps the rows already shown.
          setTaskSessionError(taskSessionErrorMessage(result.error))
          setTaskSessionStatus(
            taskSessionsRef.current.length > 0 ? "ready" : "error"
          )
          return
        }
        setTaskSessionStatus("error")
        setTaskSessionError(taskSessionErrorMessage(result.error))
        return
      }
      setTaskSessions((previous) => {
        const next = options.append
          ? appendDedupedTaskSessions(previous, result.page.sessions)
          : result.page.sessions
        taskSessionsRef.current = next
        return next
      })
      // The project catalog is cumulative: a project discovered on page 1
      // stays selectable after Load more.
      setTaskSessionProjects((previous) => {
        const seen = new Set(previous.map((project) => project.token))
        const merged = [...previous]
        for (const project of result.page.projects) {
          if (seen.has(project.token)) continue
          seen.add(project.token)
          merged.push(project)
        }
        return merged
      })
      setTaskSessionPageToken(result.page.nextPageToken)
      setTaskSessionHasMore(result.page.hasMore)
      setTaskSessionStatus("ready")
    },
    [requestTaskSessions]
  )

  const handleTaskSessionModeChange = useCallback(
    (mode: "new" | "continue") => {
      setTaskSessionMode(mode)
      setTaskError("")
      if (mode === "new") {
        // Returning to New session abandons the picker: no discovery request
        // is left in flight and no selection is silently retained.
        resetTaskSessionPicker()
        setTaskSessionMode("new")
        return
      }
      if (!taskAgent) return
      void loadTaskSessions(taskAgent.peerId, { append: false })
    },
    [loadTaskSessions, resetTaskSessionPicker, taskAgent]
  )

  const handleTaskSessionProjectChange = useCallback(
    (token: string | null) => {
      if (!taskAgent) return
      setTaskSessionProjectToken(token)
      setTaskSessionSelection(null)
      void loadTaskSessions(taskAgent.peerId, {
        ...(token ? { projectToken: token } : {}),
        append: false,
      })
    },
    [loadTaskSessions, taskAgent]
  )

  /**
   * #409: an EXPLICIT refresh re-runs the whole Runtime -> Harness
   * `session/list` round trip for the current project view. It is deliberately
   * not a re-render of loaded rows and not a browser cache: the Room re-asks
   * the resident Runtime, which re-asks the Harness, so a provider that gained
   * or lost a session since the last look is reflected immediately.
   */
  const handleTaskSessionRefresh = useCallback(() => {
    if (!taskAgent) return
    void loadTaskSessions(taskAgent.peerId, {
      ...(taskSessionProjectToken
        ? { projectToken: taskSessionProjectToken }
        : {}),
      append: false,
    })
  }, [loadTaskSessions, taskAgent, taskSessionProjectToken])

  const handleTaskSessionLoadMore = useCallback(() => {
    if (!taskAgent || !taskSessionPageToken) return
    void loadTaskSessions(taskAgent.peerId, {
      ...(taskSessionProjectToken
        ? { projectToken: taskSessionProjectToken }
        : {}),
      pageToken: taskSessionPageToken,
      append: true,
    })
  }, [
    loadTaskSessions,
    taskAgent,
    taskSessionPageToken,
    taskSessionProjectToken,
  ])

  /**
   * #421: a large Start Task paste is a Task BRIEF, not textarea content.
   *
   * It reuses the ONE shared big-paste primitive the active-Task composer
   * already uses, so the exact document becomes a Task-correlated text/markdown
   * attachment and the canonical Task references it. The textarea keeps only
   * the Human's own short instruction, which is what the Agent's wake carries.
   *
   * The whole rule is a PASTE rule, never a total-length rule: text the Human
   * typed or edited is never silently moved or dropped. A paste the bounded
   * Task attachment store cannot hold fails visibly instead of truncating.
   */
  const handleTaskInstructionPaste = (
    event: React.ClipboardEvent<HTMLTextAreaElement>
  ) => {
    if (taskBrief || taskStarting) return
    const pasted = event.clipboardData?.getData("text/plain") ?? ""
    if (!isLargeTaskPaste(pasted)) return
    if (!taskPasteFitsAttachment(pasted)) {
      setTaskBriefNotice(
        "That paste is larger than a task brief can hold (768 KB). Split it, or attach it inside the task."
      )
      return
    }
    taskBriefText.current = pasted
    setTaskBrief(taskPasteAttachment(pasted))
    setTaskBriefNotice("")
    setTaskError("")
    // Keep the giant body out of the textarea; the chip carries it.
    event.preventDefault()
  }

  const submitTask = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!taskAgent || taskStarting) return
      // #421: a staged large brief is the Task's context. The canonical Task
      // summary is either the Human's own short instruction or a bounded label
      // derived from the brief — never a truncated copy of it, because the
      // exact document travels in the referenced attachment.
      const briefSummary = taskBrief
        ? taskInstruction.trim() ||
          taskBriefLabel(taskBriefText.current) ||
          TASK_BRIEF_DEFAULT_LABEL
        : ""
      if (taskSessionMode === "new" || !taskAgentContinuation) {
        if (taskBrief) {
          setTaskError("")
          setTaskStarting(true)
          const started = await startTaskWithBrief(
            taskAgent.peerId,
            briefSummary,
            taskBrief
          )
          setTaskStarting(false)
          if (!started) {
            // FAIL CLOSED: no Task was created and the Human's brief is still
            // staged, so a Task can never start with missing context.
            setTaskError(
              "Could not attach the brief, so the task was not started. Your text is still here."
            )
            return
          }
          pendingLocalTaskSummaries.current.push(briefSummary)
          closeTaskComposer()
          return
        }
        // The New session path is structurally unchanged.
        const sent = sendCollabRequest(taskAgent.peerId, taskInstruction)
        if (!sent) {
          setTaskError("Could not start the task. Check your connection.")
          return
        }
        pendingLocalTaskSummaries.current.push(taskInstruction.trim())
        closeTaskComposer()
        return
      }
      const selection = taskSessionSelection
      if (!selection) {
        setTaskError("Choose a local session to continue.")
        return
      }
      setTaskError("")
      setTaskStarting(true)
      const result = await startTaskWithSession(
        taskAgent.peerId,
        selection.token,
        taskBrief ? briefSummary : taskInstruction
      )
      setTaskStarting(false)
      if (result.ok === false) {
        // The modal stays OPEN and the typed instruction is preserved: a
        // failed preparation created no Task, and Free4Chat never silently
        // falls back to a new session.
        setTaskError(taskSessionErrorMessage(result.error))
        return
      }
      pendingLocalTaskSummaries.current.push(
        taskBrief ? briefSummary : taskInstruction.trim()
      )
      setTaskAgent(null)
      setTaskInstruction("")
      setTaskError("")
      resetTaskSessionPicker()
    },
    [
      closeTaskComposer,
      resetTaskSessionPicker,
      sendCollabRequest,
      startTaskWithBrief,
      startTaskWithSession,
      taskAgent,
      taskAgentContinuation,
      taskBrief,
      taskInstruction,
      taskSessionMode,
      taskSessionSelection,
      taskStarting,
    ]
  )

  // #409: one bounded transient control. It sends no chat text and creates no
  // Room history; a failed send only surfaces the existing lightweight
  // unavailable state next to the control.
  const handleTaskInterrupt = useCallback(
    (taskRequestId: string, turnSequence: number) => {
      setTaskInterruptFailed(!sendTaskInterrupt(taskRequestId, turnSequence))
    },
    [sendTaskInterrupt]
  )

  // #409: one structured command. The Room durably queues the instruction
  // BEFORE it stops the exact turn, so a failed interrupt still leaves the
  // instruction queued (reported truthfully, never silently resent).
  const handleTaskInterruptAndSend = useCallback(
    (taskRequestId: string, turnSequence: number, text: string) => {
      const sent = sendTaskInterruptAndSend(taskRequestId, turnSequence, text)
      setTaskInterruptFailed(!sent)
      return sent
    },
    [sendTaskInterruptAndSend]
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
    const check = () => {
      const nextIsMd = window.innerWidth >= 768
      setIsMd(nextIsMd)
      if (!mobileSurfaceInitialized.current) {
        mobileSurfaceInitialized.current = true
        // A direct Room App is an explicit visual-entry intent. Every ordinary
        // phone Room starts people-first instead.
        if (!nextIsMd && !initialRoomAppId) setMobileRoomSheetOpen(true)
      }
    }
    check()
    window.addEventListener("resize", check)
    return () => window.removeEventListener("resize", check)
  }, [initialRoomAppId])

  // Phone sheet geometry. The participant/Stage panel is ONE mount — one
  // participant list, one Stage, one launcher, one resident App host — so the
  // sheet never duplicates it: the same element is either the ordinary desktop
  // split pane or the phone overlay, and the shell around it is `contents` (a
  // no-op in the desktop box tree) whenever it is not an overlay.
  //
  // A fullscreen Room App is a Room layout state, not a phone sheet: it already
  // hides and inerts every surrounding surface, so it keeps the whole content
  // region instead of being trapped behind a closed sheet.
  const mobileSheetVisible =
    mobileRoomSheetOpen && !isMd && !isRoomAppFullscreen
  const stagePanelVisible = mobileSheetVisible || isRoomAppFullscreen

  // A viewport that crosses to `md` while the phone sheet is open must land on
  // the ordinary desktop split; phone-only overlay state never leaks into it.
  useEffect(() => {
    if (isMd) setMobileRoomSheetOpen(false)
  }, [isMd])

  useEffect(() => {
    // Selecting a Task is deliberate interaction intent. Do not leave the
    // people-first sheet over the Task's full-height conversation.
    if (!isMd && activeInteraction !== "room") setMobileRoomSheetOpen(false)
  }, [activeInteraction, isMd])

  // Escape closes the phone sheet, exactly like its explicit close control.
  useEffect(() => {
    if (!mobileSheetVisible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setMobileRoomSheetOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [mobileSheetVisible])

  useEffect(() => {
    // A Room App is a large visual surface like screen share, so it gets the
    // wide Stage rather than a conversation-sized pane.
    setSplitRatio(activeScreenShares.length > 0 || stageAppVisible ? 75 : 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScreenShares.length > 0, stageAppVisible])

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
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="min-w-0 truncate text-lg font-medium lg:flex-none">
              #{roomName}
            </h1>
            {/* Phone signal line. Below `md` this is the whole "who is here and
                what is the Agent doing" projection, so the interaction pane can
                own the viewport instead of a row of participant cards. It is
                plain bounded text and never a control. */}
            <p
              data-testid="room-mobile-signal"
              className="truncate text-xs text-gray-400 md:hidden"
            >
              {mobileRoomSignal}
            </p>
          </div>
          {/* The one mounted participant/Stage panel is discoverable by purpose,
              not a generic overflow glyph. */}
          <button
            type="button"
            data-testid="room-mobile-overflow"
            aria-expanded={mobileSheetVisible}
            aria-label="Show participants and Stage"
            title="Show participants and Stage"
            onClick={() => setMobileRoomSheetOpen((open) => !open)}
            className="shrink-0 rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-700 md:hidden"
          >
            People ({participants.length})
          </button>
          <button
            type="button"
            onClick={() => {
              leaveRoom()
              router.push("/")
            }}
            className={`room-header-leave ${
              mobileSheetVisible ? "inline-flex" : "hidden"
            } shrink-0 rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 lg:hidden`}
          >
            Leave
          </button>
        </div>
        <div
          data-testid="room-header-features"
          className={`${
            mobileSheetVisible ? "flex" : "hidden md:flex"
          } flex-none flex-col gap-2 lg:ml-auto lg:flex-row lg:items-center lg:gap-2`}
        >
          {/* #421: phone controls are secondary to people and Stage. They are
              shown only while that people-first surface is open, and remain a
              single mounted toolbar at every breakpoint. */}
          <div
            data-testid="room-header-toolbar"
            className={`${
              mobileSheetVisible ? "grid" : "hidden md:grid"
            } room-header-toolbar grid-cols-3 gap-2 lg:flex lg:items-center`}
          >
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
        className="room-content flex flex-1 flex-col overflow-hidden max-md:relative md:flex-row"
      >
        {/* Phone composition. Below `md` the participant/Stage panel is hidden
            by default so the Room/Task interaction owns the viewport, and the
            `⋯` control reveals this ONE panel as a full-height sheet.

            The sheet is geometry, not a second copy: swapping `contents` for
            the overlay moves the same mounted panel, so participant cards, the
            Stage switcher, the App launcher, `WorkspaceSnapshots` and every
            resident App host keep exactly one instance and their
            iframe/MessagePort state. It covers this content region, which
            begins directly below the header, rather than a hard-coded header
            height — so the header keeps the only copy of Copy link / Invite
            Agent / Live Transcript / mic / Leave reachable while it is open.
            `max-md:relative` above is the containing block for it and is
            deliberately absent at `md`+, where the desktop box tree is exactly
            the one that shipped. */}
        <div
          data-testid={mobileSheetVisible ? "room-mobile-sheet" : undefined}
          className={
            mobileSheetVisible
              ? "absolute inset-0 z-30 flex flex-col overflow-y-auto overscroll-contain bg-gray-900"
              : "contents"
          }
        >
          {mobileSheetVisible && (
            <div className="flex flex-none items-center justify-between gap-2 border-b border-gray-800 bg-gray-950/80 px-3 py-2">
              <span className="min-w-0 truncate text-xs uppercase tracking-wide text-gray-400">
                People in this Room
              </span>
              <button
                type="button"
                data-testid="room-mobile-sheet-close"
                onClick={() => {
                  setActiveInteraction("room")
                  setMobileRoomSheetOpen(false)
                }}
                aria-label="Open Room chat"
                className="shrink-0 rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
              >
                Room chat
              </button>
            </div>
          )}
          {/* Room App focus mode is an ordinary Room layout state, not a
              viewport-fixed overlay: every surrounding surface below is already
              hidden and inert, so the Stage simply takes the whole Room content
              region and the resident host fills it. A `position: fixed`
              descendant could not escape this split, `overflow-hidden` Stage on
              iPad Safari — it was clipped at the old Stage/chat boundary, taking
              the host's right-side chrome ("Exit fullscreen") with it. */}
          <div
            data-testid="room-stage"
            className={`room-panel room-participants-panel ${
              stagePanelVisible ? "flex" : "hidden md:flex"
            } flex-1 flex-col overflow-hidden border-b border-gray-800 md:flex-none md:border-b-0 md:border-r`}
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
                Boolean(activeTaskLiveView) ||
                Boolean(activeTaskGeneratedApp)) && (
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
                      aria-pressed={stageView === "screen" && !stageAppVisible}
                      className={`shrink-0 rounded px-2 py-1 text-xs ${
                        stageView === "screen" && !stageAppVisible
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
                      aria-pressed={
                        stageView === "live-view" && !stageAppVisible
                      }
                      className={`shrink-0 rounded px-2 py-1 text-xs ${
                        stageView === "live-view" && !stageAppVisible
                          ? "bg-blue-600 text-white"
                          : "text-gray-400 hover:bg-gray-800"
                      }`}
                    >
                      Live View
                    </button>
                  )}
                  {activeTaskGeneratedApp && (
                    <button
                      type="button"
                      data-testid="stage-view-generated-app"
                      onClick={() =>
                        void openGeneratedApp(activeTaskGeneratedApp)
                      }
                      aria-pressed={Boolean(visibleGeneratedRoomApp)}
                      className={`shrink-0 rounded px-2 py-1 text-xs ${
                        visibleGeneratedRoomApp
                          ? "bg-blue-600 text-white"
                          : "text-gray-400 hover:bg-gray-800"
                      }`}
                    >
                      {generatedAppLoading ===
                      activeTaskGeneratedApp.appInstanceId
                        ? "Loading App…"
                        : "Task App"}
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
                Object.values(generatedAppDocuments).map((document) => {
                  const publication = document.publication
                  const visible =
                    activeGeneratedAppId === publication.appInstanceId
                  const app = {
                    id: publication.appInstanceId,
                    label: publication.title,
                    url: "https://room-apps.free4.chat/generated",
                    origin: "https://room-apps.free4.chat",
                    source: "generated" as const,
                    srcDoc: generatedRoomAppSrcDoc(document.bundle),
                  }
                  return (
                    <div
                      key={publication.appInstanceId}
                      data-testid={`generated-room-app-slot-${publication.appInstanceId}`}
                      aria-hidden={!visible}
                      inert={!visible}
                      className={
                        visible ? "flex min-h-0 flex-1 flex-col" : "hidden"
                      }
                    >
                      <RoomAppHost
                        app={app}
                        appInstanceId={publication.appInstanceId}
                        self={roomAppSelf}
                        participants={roomAppParticipants}
                        subscribe={subscribeRoomAppMessages}
                        send={sendRoomAppMessage}
                        sharedState={{
                          revision: publication.stateRevision,
                          state: document.state,
                        }}
                        sendGeneratedState={sendGeneratedAppState}
                        subscribeGeneratedState={subscribeGeneratedAppState}
                        onReady={handleRoomAppReady}
                        subscribeUnicast={subscribeRoomAppUnicast}
                        subscribeUnicastResults={subscribeRoomAppUnicastResults}
                        sendUnicast={sendRoomAppUnicast}
                        onClose={() => setActiveGeneratedAppId(null)}
                      />
                    </div>
                  )
                })}
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
                        onToggleFullscreen={() =>
                          toggleRoomAppFullscreen(app.id)
                        }
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
              {!stageAppVisible &&
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
          // The phone sheet covers this pane, so it gets the same
          // "covered means inert" contract the fullscreen guard already uses:
          // focus can never Tab into a hidden composer behind the sheet.
          aria-hidden={isRoomAppFullscreen || mobileSheetVisible}
          inert={isRoomAppFullscreen || mobileSheetVisible}
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
            {(activeTaskActivities.length > 0 ||
              Boolean(activeTaskExecutionLabel?.label) ||
              activeTaskTurn !== undefined ||
              activeTaskInterrupting ||
              activeTaskExecutionAmbiguous ||
              Boolean(activeTaskLocalError) ||
              Boolean(activeTaskControlNotice)) && (
              <div
                data-testid="task-agent-activity"
                className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-800 bg-gray-950/40 px-3 py-1.5 text-xs text-blue-200/80"
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
                {/* #421 Fix C: the coarse verb above is presentation only, so
                    fall back to the AUTHORITATIVE execution label. A Task that
                    the Room reports as Running must never look idle just
                    because the separate AgentActivity projection is missing
                    (hibernation, reconciliation). */}
                {(activeTaskExecutionLabel?.label ?? "") !== "" && (
                  <span>
                    {activeTaskExecution?.agentParticipantId
                      ? `${
                          participants.find(
                            (candidate) =>
                              candidate.peerId ===
                              activeTaskExecution.agentParticipantId
                          )?.name ?? "Agent"
                        } · `
                      : ""}
                    {activeTaskExecutionLabel?.label}
                    {activeTaskExecutionLabel?.detail
                      ? ` · ${activeTaskExecutionLabel.detail}`
                      : ""}
                  </span>
                )}
                {activeTaskExecutionAmbiguous && (
                  <span
                    role="status"
                    data-testid="task-execution-ambiguous"
                    className="text-amber-200"
                  >
                    Multiple Agents are running this Task; interrupt is
                    unavailable.
                  </span>
                )}
                {/* #421 Fix G: benign control outcomes are transient LOCAL
                    feedback. They never become a Room-wide sticky banner. */}
                {activeTaskControlNotice ? (
                  <span
                    role="status"
                    data-testid="task-control-notice"
                    className="text-gray-300"
                  >
                    {activeTaskControlNotice}
                  </span>
                ) : null}
                {activeTaskLocalError ? (
                  <span
                    role="alert"
                    data-testid="task-local-error"
                    className="text-amber-200"
                  >
                    {activeTaskLocalError}
                  </span>
                ) : null}
                {activeTask && activeTaskInterrupting && (
                  <span data-testid="task-interrupting" className="sr-only">
                    Interrupting
                  </span>
                )}
                {activeTask && activeTaskTurn !== undefined && (
                  // #409/#421 Fix C: shown while the AUTHORITATIVE execution
                  // projection reports a current turn for the Room-accepted
                  // executor of this Task. Task.status is a retained-message
                  // projection and is deliberately NOT used as a running
                  // signal, and a missing/stale AgentActivity can no longer
                  // hide the control for a Task that is genuinely running.
                  <button
                    type="button"
                    data-testid="task-interrupt"
                    disabled={activeTaskInterrupting}
                    onClick={() =>
                      handleTaskInterrupt(activeTask.requestId, activeTaskTurn)
                    }
                    className="ml-auto rounded border border-gray-700 px-2 py-0.5 text-[11px] text-gray-300 hover:border-red-500/60 hover:text-red-200"
                    aria-label={`Interrupt ${activeTask.title}`}
                  >
                    {taskInterruptFailed
                      ? "Interrupt unavailable"
                      : "Interrupt"}
                  </button>
                )}
              </div>
            )}
            {/* The conversation pane always renders the selected Room/Task
                conversation; an active Room App lives on the Stage instead. */}
            {activeTaskGeneratedApp && (
              <div
                data-testid="generated-room-app-card"
                className="flex flex-none items-center justify-between gap-3 border-b border-gray-800 bg-blue-950/20 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-blue-100">
                    Generated Room App
                  </div>
                  <div className="truncate text-xs text-gray-400">
                    {activeTaskGeneratedApp.title}
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded border border-blue-700 px-2 py-1 text-xs text-blue-100 hover:bg-blue-900/60"
                  onClick={() => void openGeneratedApp(activeTaskGeneratedApp)}
                >
                  {generatedAppLoading === activeTaskGeneratedApp.appInstanceId
                    ? "Loading…"
                    : "Open App"}
                </button>
              </div>
            )}
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
                onSendTaskFile={
                  activeTaskCanAdoptReplacement
                    ? undefined
                    : wrappedSendTaskFile
                }
                taskExecution={
                  activeTask
                    ? {
                        interrupting: activeTaskInterrupting,
                        // #421 Fix C: interrupt authority is the AUTHORITATIVE
                        // execution projection's exact current turn. The
                        // presentation-only AgentActivity can be absent or
                        // stale and must never remove control.
                        interruptible:
                          activeTaskTurn !== undefined &&
                          !activeTaskInterrupting,
                        onInterrupt: () => {
                          if (activeTaskTurn === undefined) return
                          handleTaskInterrupt(
                            activeTask.requestId,
                            activeTaskTurn
                          )
                        },
                        onInterruptAndSend: (text: string) =>
                          activeTaskTurn === undefined
                            ? false
                            : handleTaskInterruptAndSend(
                                activeTask.requestId,
                                activeTaskTurn,
                                text
                              ),
                      }
                    : undefined
                }
                onSendAction={sendActionMessage}
                localParticipantId={effectiveLocalParticipantId}
                onCollabRespond={handleCollabRespond}
                onReadArtifact={handleReadArtifact}
                onCollabResult={handleCollabResult}
                onPermissionRespond={handlePermissionResponse}
                taskAvailable={
                  !activeTaskUnavailable || activeTaskCanAdoptReplacement
                }
                taskRequiresExplicitTarget={activeTaskCanAdoptReplacement}
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
            {/* #409: the session choice is offered ONLY when this Agent's
                resident Runtime advertised Task Session Continuation. An
                older Runtime (agent-v0.5.34) never does, so this block is
                absent and the modal is byte-for-byte the previous one. */}
            {taskAgentContinuation && (
              <fieldset
                className="mb-4"
                disabled={taskStarting}
                data-testid="task-session-mode"
              >
                <legend className="mb-2 block text-sm text-gray-200">
                  Session
                </legend>
                <div
                  role="radiogroup"
                  aria-label="Session"
                  className="flex gap-2"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={taskSessionMode === "new"}
                    data-testid="task-session-mode-new"
                    onClick={() => handleTaskSessionModeChange("new")}
                    className={`flex-1 rounded-md border px-3 py-1.5 text-xs ${
                      taskSessionMode === "new"
                        ? "border-blue-400 bg-blue-600/20 text-white"
                        : "border-gray-700 text-gray-300 hover:bg-gray-800"
                    }`}
                  >
                    New session
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={taskSessionMode === "continue"}
                    data-testid="task-session-mode-continue"
                    onClick={() => handleTaskSessionModeChange("continue")}
                    className={`flex-1 rounded-md border px-3 py-1.5 text-xs ${
                      taskSessionMode === "continue"
                        ? "border-blue-400 bg-blue-600/20 text-white"
                        : "border-gray-700 text-gray-300 hover:bg-gray-800"
                    }`}
                  >
                    Continue session
                  </button>
                </div>
                {taskSessionMode === "continue" && (
                  <div className="mt-3">
                    <TaskSessionPicker
                      status={taskSessionStatus}
                      sessions={taskSessions}
                      projects={taskSessionProjects}
                      hasMore={taskSessionHasMore}
                      loadingMore={taskSessionLoadingMore}
                      error={taskSessionError}
                      selectedToken={taskSessionSelection?.token ?? null}
                      projectToken={taskSessionProjectToken}
                      onSelect={setTaskSessionSelection}
                      onProjectChange={handleTaskSessionProjectChange}
                      onLoadMore={handleTaskSessionLoadMore}
                      onRefresh={handleTaskSessionRefresh}
                      refreshing={taskSessionStatus === "loading"}
                      disabled={taskStarting}
                    />
                  </div>
                )}
              </fieldset>
            )}
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
              onPaste={handleTaskInstructionPaste}
              maxLength={MAX_COLLAB_SUMMARY_LENGTH}
              rows={4}
              autoFocus
              disabled={taskStarting}
              className="w-full resize-none rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 disabled:opacity-50"
            />
            {/* #421: a large paste is the Task brief, carried as one
                Task-correlated text/markdown attachment. The exact document is
                preserved; only a bounded label is shown here. */}
            {taskBrief && (
              <div
                data-testid="task-brief-chip"
                className="mt-2 flex items-start gap-2 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-gray-300"
              >
                <span aria-hidden="true">📎</span>
                <span className="min-w-0 flex-1 break-words">
                  {taskBrief.name} · {taskBriefText.current.length} characters
                  attached as this task&apos;s brief
                </span>
                <button
                  type="button"
                  onClick={() => {
                    taskBriefText.current = ""
                    setTaskBrief(null)
                    setTaskBriefNotice("")
                  }}
                  disabled={taskStarting}
                  className="shrink-0 text-gray-400 hover:text-white disabled:opacity-50"
                  aria-label="Remove the attached brief"
                >
                  ×
                </button>
              </div>
            )}
            {taskBriefNotice && (
              <p role="alert" className="mt-2 text-xs text-amber-300">
                {taskBriefNotice}
              </p>
            )}
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
                disabled={
                  // #421: a staged brief IS the instruction, so the primary
                  // action stays reachable for a brief-only start — the Human
                  // must never have to create an empty Task first.
                  (!taskInstruction.trim() && !taskBrief) ||
                  taskStarting ||
                  (taskAgentContinuation &&
                    taskSessionMode === "continue" &&
                    !taskSessionSelection)
                }
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {taskStarting
                  ? "Starting…"
                  : taskAgentContinuation
                  ? "Start task"
                  : "Send"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}
