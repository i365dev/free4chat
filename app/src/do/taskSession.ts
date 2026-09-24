import type { RoomParticipant, RoomRuntimeFeatures } from "../room/types"

/*
 * #409 Task Session Continuation — Room-side bounds and sanitization.
 *
 * This module is pure and DO-free, so the rules stay deterministically
 * testable (the same shape as do/collab.ts and do/meetingNotesAuth.ts).
 *
 * The Room is a RELAY here, never a store:
 *
 *   - it never sees a real ACP session id, cwd, or provider cursor: those
 *     never leave the Runtime;
 *   - it never persists discovery data, never appends a Room message for
 *     browsing, and never wakes a waiter for it;
 *   - every pending record lives in a bounded WebSocket ATTACHMENT, because a
 *     Durable Object can hibernate and lose ordinary object memory while its
 *     sockets survive (see the hibernation-safe correlation contract below).
 */

/** One discovery response carries at most this many rows. */
export const MAX_TASK_SESSION_ROWS = 10
/** One discovery response carries at most this many project choices. */
export const MAX_TASK_SESSION_PROJECTS = 24
/** Bounds the opaque Runtime-issued selection/project/page handles. */
export const MAX_TASK_SESSION_TOKEN_LENGTH = 64
/** Display-only Harness title bound. Untrusted input, so it is bounded twice. */
export const MAX_TASK_SESSION_TITLE_LENGTH = 256
/** Display-only project label bound. */
export const MAX_TASK_SESSION_PROJECT_LABEL_LENGTH = 256
/** Bounds the browser-supplied idempotency correlation for one Start. */
export const MAX_TASK_SESSION_CLIENT_REQUEST_ID_LENGTH = 64

/**
 * One outstanding discovery/start per Human socket, and one outstanding
 * session-control per resident socket. Each pending record expires, so a
 * Human who closes the modal cannot leave a permanent slot occupied.
 */
export const TASK_SESSION_PENDING_TTL_MS = 20_000

/** The closed set of bounded, actionable failure classes the Room relays. */
export const TASK_SESSION_ERRORS = [
  "session_continuation_unsupported",
  "invalid_session_control",
  "session_control_busy",
  "session_selection_expired",
  "session_continuation_unavailable",
  "task_project_unavailable",
  "task_harness_control_unavailable",
  "task_session_busy",
  "task_agent_not_reachable",
  "task_session_not_pending",
] as const

export type TaskSessionError = (typeof TASK_SESSION_ERRORS)[number]

const TASK_SESSION_ERROR_SET = new Set<string>(TASK_SESSION_ERRORS)

/** Narrows one untrusted Runtime error string to the closed relay set. */
export function isTaskSessionError(value: unknown): value is TaskSessionError {
  return typeof value === "string" && TASK_SESSION_ERROR_SET.has(value)
}

/**
 * The client-visible message for each bounded failure class. Nothing raw from
 * the Runtime, the adapter, or the filesystem is ever shown: an ACP error can
 * quote local session identity or an absolute path.
 */
export function taskSessionErrorMessage(error: TaskSessionError): string {
  switch (error) {
    case "session_selection_expired":
      return "This local session is no longer available. Refresh sessions and try again."
    case "session_continuation_unsupported":
    case "invalid_session_control":
      return "This Agent cannot continue a local session."
    case "session_control_busy":
    case "task_session_busy":
      return "Another session request is still in progress. Try again in a moment."
    case "task_agent_not_reachable":
      return "That Agent is not reachable right now."
    case "task_session_not_pending":
      return "The session request expired. Refresh sessions and try again."
    case "task_project_unavailable":
      return "That local project is no longer available. Refresh projects and try again."
    case "task_harness_control_unavailable":
      return "That Harness control is no longer available. Refresh and choose another option."
    case "session_continuation_unavailable":
    default:
      return "Could not continue that local session. Your instruction was not sent."
  }
}

/**
 * Sanitizes the additive Runtime feature projection fail-closed.
 *
 * Returns `undefined` for anything that is not exactly the documented closed
 * shape, so a malformed or hostile projection can never enable the feature.
 * This is discovery only; it is never authorization.
 */
export function sanitizeRuntimeFeatures(
  input: unknown
): RoomRuntimeFeatures | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined
  const candidate = input as Record<string, unknown>
  // Every feature is kept INDEPENDENTLY: a Runtime that advertises only
  // reconciliation (any launcher) must not have that dropped because it does
  // not also support Task Session Continuation.
  const features: RoomRuntimeFeatures = {}
  if (candidate.taskSessionContinuation === true)
    features.taskSessionContinuation = true
  if (candidate.taskExecutionReconciliation === true)
    features.taskExecutionReconciliation = true
  return Object.keys(features).length > 0 ? features : undefined
}

/**
 * Reports whether the Room may send the private execution-resync control to
 * this resident.
 *
 * This is a TRANSPORT-COMPATIBILITY gate, not authorization: the frame carries
 * no authority, no tokens, and no payload, and the Runtime re-derives every
 * projection it publishes. It exists only so a new Room never writes an
 * unknown private frame to a Runtime that predates it.
 */
export function agentSupportsTaskExecutionReconciliation(
  participant: Pick<RoomParticipant, "kind" | "connected" | "runtimeFeatures">
): boolean {
  return (
    participant.kind === "agent" &&
    participant.connected &&
    participant.runtimeFeatures?.taskExecutionReconciliation === true
  )
}

/**
 * Reports whether this Agent participant may be offered "Continue session".
 *
 * This is a PRESENTATION gate. It is deliberately checked again server-side on
 * every task-session action; it never authorizes anything by itself.
 */
export function agentSupportsTaskSessionContinuation(
  participant: Pick<RoomParticipant, "kind" | "connected" | "runtimeFeatures">
): boolean {
  return (
    participant.kind === "agent" &&
    participant.connected &&
    participant.runtimeFeatures?.taskSessionContinuation === true
  )
}

/**
 * Bounds and folds one untrusted display string. A native session title can
 * contain arbitrary user or model text, so it is flattened to a single line
 * and cut to a fixed length before it can reach a browser. It is rendered as
 * PLAIN TEXT (never HTML, never markdown).
 */
export function boundedTaskSessionText(value: unknown, limit: number): string {
  if (typeof value !== "string") return ""
  // eslint-disable-next-line no-control-regex
  const folded = value.replace(/[\u0000-\u001f\u007f]/g, " ")
  const trimmed = folded.trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

/** Bounds one opaque Runtime-issued token without repairing it. */
export function isValidTaskSessionToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TASK_SESSION_TOKEN_LENGTH &&
    value.trim() === value
  )
}

export interface RelayTaskSession {
  token: string
  title: string
  projectToken: string
  projectLabel: string
  updatedAt?: string
}

export interface RelayTaskSessionProject {
  token: string
  label: string
}

export interface RelayHarnessSessionMode {
  id: string
  name?: string
  description?: string
}

export interface RelayHarnessSessionConfigValue {
  value: string
  name?: string
  description?: string
}

export interface RelayHarnessSessionConfigOption {
  id: string
  name?: string
  description?: string
  category?: string
  type?: string
  currentValue?: string
  options: RelayHarnessSessionConfigValue[]
}

export interface RelayHarnessSessionControls {
  currentModeId?: string
  modes: RelayHarnessSessionMode[]
  configOptions: RelayHarnessSessionConfigOption[]
}

export interface TaskSessionListResult {
  ok: true
  sessions: RelayTaskSession[]
  projects: RelayTaskSessionProject[]
  nextPageToken?: string
  hasMore: boolean
  controls?: RelayHarnessSessionControls
}

export type TaskSessionListOutcome =
  | TaskSessionListResult
  | { ok: false; error: TaskSessionError }

/**
 * Validates one Runtime discovery response fail-closed. A row that is missing
 * an opaque token, or that exceeds a bound, invalidates the WHOLE page rather
 * than being dropped: the browser must never be shown a partially-truncated
 * list it would mistake for the complete store.
 *
 * The result carries only presentation data. A real session id, a real cwd, or
 * a provider cursor has no field to travel in.
 */
export function validateTaskSessionListResult(
  input: unknown
): TaskSessionListOutcome {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "session_continuation_unavailable" }
  const raw = input as Record<string, unknown>
  if (raw.ok !== true) {
    return {
      ok: false,
      error: isTaskSessionError(raw.error)
        ? raw.error
        : "session_continuation_unavailable",
    }
  }
  const sessions = raw.sessions ?? []
  const projects = raw.projects ?? []
  if (!Array.isArray(sessions) || sessions.length > MAX_TASK_SESSION_ROWS)
    return { ok: false, error: "session_continuation_unavailable" }
  if (!Array.isArray(projects) || projects.length > MAX_TASK_SESSION_PROJECTS)
    return { ok: false, error: "session_continuation_unavailable" }

  const relayedSessions: RelayTaskSession[] = []
  for (const row of sessions) {
    if (!row || typeof row !== "object") continue
    const candidate = row as Record<string, unknown>
    if (
      !isValidTaskSessionToken(candidate.token) ||
      !isValidTaskSessionToken(candidate.projectToken)
    )
      return { ok: false, error: "session_continuation_unavailable" }
    relayedSessions.push({
      token: candidate.token,
      title: boundedTaskSessionText(
        candidate.title,
        MAX_TASK_SESSION_TITLE_LENGTH
      ),
      projectToken: candidate.projectToken,
      projectLabel: boundedTaskSessionText(
        candidate.projectLabel,
        MAX_TASK_SESSION_PROJECT_LABEL_LENGTH
      ),
      ...(typeof candidate.updatedAt === "string" &&
      candidate.updatedAt.length > 0 &&
      candidate.updatedAt.length <= 64
        ? { updatedAt: candidate.updatedAt }
        : {}),
    })
  }

  const relayedProjects: RelayTaskSessionProject[] = []
  for (const project of projects) {
    if (!project || typeof project !== "object") continue
    const candidate = project as Record<string, unknown>
    if (!isValidTaskSessionToken(candidate.token))
      return { ok: false, error: "session_continuation_unavailable" }
    relayedProjects.push({
      token: candidate.token,
      label: boundedTaskSessionText(
        candidate.label,
        MAX_TASK_SESSION_PROJECT_LABEL_LENGTH
      ),
    })
  }

  const controls = relayHarnessSessionControls(raw.controls)
  if (raw.controls !== undefined && controls === null)
    return { ok: false, error: "session_continuation_unavailable" }

  const nextPageToken = isValidTaskSessionToken(raw.nextPageToken)
    ? raw.nextPageToken
    : undefined
  return {
    ok: true,
    sessions: relayedSessions,
    projects: relayedProjects,
    hasMore: nextPageToken !== undefined,
    ...(nextPageToken ? { nextPageToken } : {}),
    ...(controls ? { controls } : {}),
  }
}

function relayHarnessSessionControls(
  input: unknown
): RelayHarnessSessionControls | null {
  if (input === undefined) return null
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const modes = raw.modes ?? []
  const configOptions = raw.configOptions ?? []
  if (!Array.isArray(modes) || modes.length > 32) return null
  if (!Array.isArray(configOptions) || configOptions.length > 16) return null
  const currentModeId =
    raw.currentModeId === undefined
      ? undefined
      : boundedNativeControlText(raw.currentModeId, 128)
  if (raw.currentModeId !== undefined && !currentModeId) return null
  const relayedModes: RelayHarnessSessionMode[] = []
  for (const item of modes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const mode = item as Record<string, unknown>
    const id = boundedNativeControlText(mode.id, 128)
    if (!id) return null
    relayedModes.push({
      id,
      ...(typeof mode.name === "string"
        ? { name: boundedTaskSessionText(mode.name, 128) }
        : {}),
      ...(typeof mode.description === "string"
        ? { description: boundedTaskSessionText(mode.description, 256) }
        : {}),
    })
  }
  const relayedOptions: RelayHarnessSessionConfigOption[] = []
  for (const item of configOptions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const option = item as Record<string, unknown>
    const id = boundedNativeControlText(option.id, 128)
    const values = option.options ?? []
    if (!id || !Array.isArray(values) || values.length > 32) return null
    const relayedValues: RelayHarnessSessionConfigValue[] = []
    for (const candidate of values) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        return null
      const value = candidate as Record<string, unknown>
      const nativeValue = boundedNativeControlText(value.value, 128)
      if (!nativeValue) return null
      relayedValues.push({
        value: nativeValue,
        ...(typeof value.name === "string"
          ? { name: boundedTaskSessionText(value.name, 128) }
          : {}),
        ...(typeof value.description === "string"
          ? { description: boundedTaskSessionText(value.description, 256) }
          : {}),
      })
    }
    relayedOptions.push({
      id,
      ...(typeof option.name === "string"
        ? { name: boundedTaskSessionText(option.name, 128) }
        : {}),
      ...(typeof option.description === "string"
        ? { description: boundedTaskSessionText(option.description, 256) }
        : {}),
      ...(typeof option.category === "string"
        ? { category: boundedTaskSessionText(option.category, 64) }
        : {}),
      ...(typeof option.type === "string"
        ? { type: boundedTaskSessionText(option.type, 64) }
        : {}),
      ...(typeof option.currentValue === "string"
        ? { currentValue: boundedTaskSessionText(option.currentValue, 128) }
        : {}),
      options: relayedValues,
    })
  }
  return {
    ...(currentModeId ? { currentModeId } : {}),
    modes: relayedModes,
    configOptions: relayedOptions,
  }
}

// Native ids and values are identity. Reject unsafe or oversized values
// instead of trimming, folding, or truncating them into another provider id.
function boundedNativeControlText(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit)
    return ""
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value) ? "" : value
}

export function isValidHarnessControlText(value: unknown): value is string {
  return boundedNativeControlText(value, 512) !== ""
}

/**
 * Merges one appended page into the rows already shown, deduplicated by the
 * opaque Runtime token. `Load more` must never grow the visible list with a
 * row the Human already has.
 */
export function appendDedupedTaskSessions(
  existing: RelayTaskSession[],
  incoming: RelayTaskSession[]
): RelayTaskSession[] {
  const seen = new Set(existing.map((row) => row.token))
  const merged = [...existing]
  for (const row of incoming) {
    if (seen.has(row.token)) continue
    seen.add(row.token)
    merged.push(row)
  }
  return merged
}

/**
 * Filters already-loaded rows by a case-insensitive substring of the title or
 * the display project label. V1 is deliberately client-side only: no index, no
 * filesystem walk, no server-side search surface.
 */
export function filterTaskSessions(
  sessions: RelayTaskSession[],
  query: string
): RelayTaskSession[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return sessions
  return sessions.filter(
    (row) =>
      row.title.toLowerCase().includes(needle) ||
      row.projectLabel.toLowerCase().includes(needle)
  )
}

/**
 * Reports whether this Human socket already has a session request in flight.
 * One outstanding discovery/start per Human socket is the cost bound: opening
 * and closing the modal repeatedly can never queue work.
 */
export function hasOutstandingTaskSessionRequest(
  attachment: {
    pendingTaskSessionDiscovery?: { requestId: string; expiresAt: number }
    pendingTaskSessionStart?: { requestId: string; expiresAt: number }
  },
  now: number
): boolean {
  const discovery = attachment.pendingTaskSessionDiscovery
  if (discovery && discovery.expiresAt > now) return true
  const start = attachment.pendingTaskSessionStart
  return Boolean(start && start.expiresAt > now)
}
