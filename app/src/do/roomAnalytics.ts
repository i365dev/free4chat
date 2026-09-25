import type { RoomParticipant } from "../room/types"

/**
 * #228: Room-authoritative collaboration-truth analytics. Canonical Room
 * transitions (AgentJoined / CollabRequested / CollabOutcome / LiveViewPublished)
 * move from
 * Human-browser observation to the Room/DO mutation boundary so browserless
 * and Agent-only Rooms are counted. Emission happens only at canonical,
 * already-deduplicated Room transitions.
 *
 * Privacy: payloads are intentionally coarse — the Room name is hashed with
 * the same 32-bit FNV-1a convention as the browser's shared hashRoom helper,
 * kinds/count are bucketed, and participant ids, names, request summaries,
 * transcript text, artifact contents, credentials, and session identifiers
 * never cross this module.
 *
 * #346: every Room-scoped event also carries the canonical generation's
 * `analyticsRoomId` (see RoomRecord.analyticsRoomId). It is read from the
 * persisted Room — never minted here — and always rides together with the
 * existing `roomHash`, which stays for historical report compatibility.
 *
 * Ingestion is the direct Mixpanel import API (the Zaraz HTTP Events route
 * was proven unreliable and is explicitly not used). MIXPANEL_PROJECT_TOKEN
 * is a preconfigured Cloudflare Worker secret; absence (local/test) makes
 * analytics a harmless no-op that can never fail or delay a Room mutation.
 */

const MIXPANEL_IMPORT_ENDPOINT = "https://api.mixpanel.com/import?strict=1"

export const SERVER_DISTINCT_ID = "server:free4chat"

export type RoomComposition =
  | "human-agent"
  | "agent-only"
  | "mixed"
  | "human-only"

export type ResolvedParticipantKind = "human" | "agent" | "unknown"

// #228: the currently OPEN 2+-participant collaboration interval state,
// persisted alongside Room state (survives DO eviction/restart).
export interface CollaborationActivity {
  startedAt: number
  sawHuman: boolean
  sawAgent: boolean
  peakParticipantCount: number
}

export interface CollaborationDurationSummary {
  durationMs: number
  collaborationMode: "human-only" | "agent-only" | "human-agent"
  participantBucket: "1" | "2-3" | "4-9" | "10+"
}

export interface RoomAnalyticsEvent {
  name:
    | "AgentJoined"
    | "RoomCreated"
    | "TargetedMessage"
    | "CollabRequested"
    | "CollabOutcome"
    | "CollaborationDuration"
    | "LiveViewPublished"
    | "RoomAppPublished"
    | "TaskControlUsed"
  properties: Record<string, unknown>
}

// #346: coarse Task duration. Raw milliseconds and start/end timestamps are
// deliberately never emitted — only which band the Task landed in.
export type TaskDurationBucket = "<1m" | "1-5m" | "5-15m" | "15-60m" | "60m+"

// #346: the supervision controls Free4Chat actually ships, each emitted ONLY
// after the Room accepted and performed the canonical action. Low
// cardinality by construction: one value per shipped control.
export type TaskControl =
  | "interrupt"
  | "interrupt-send"
  | "session-continue"
  | "permission-allow"
  | "permission-reject"
  | "permission-response"

export type RoomCreatedCreatorKind = "human" | "agent"
export type RoomCreationSource = "browser" | "agent-runtime" | "mcp"

/** Coarse analytics classification of the entry path that generated the
 * Room. Pure telemetry — never authentication, authorization, or room
 * behavior. A User-Agent can be imitated; that is acceptable for coarse
 * analytics only. */
export function classifyRoomCreationSource(
  userAgent: string
): RoomCreationSource {
  return /free4chat-agent\//i.test(userAgent) ? "agent-runtime" : "mcp"
}

// Same 32-bit FNV-1a over UTF-16 code units as the browser's shared
// hashRoom helper (common/utils). Reproduced server-side because the DO
// cannot import the browser utils module; equality is pinned by a
// cross-check test in roomAnalytics.test.ts.
export function hashRoom(roomName: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < roomName.length; i++) {
    h ^= roomName.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

// #346: the persisted canonical Room generation id is exactly what
// crypto.randomUUID() produces. Validating the shape keeps a forged or
// corrupted stored value from becoming a high-cardinality analytics
// dimension; the loader replaces anything else once and persists the healed
// record.
const ANALYTICS_ROOM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isAnalyticsRoomId(value: unknown): value is string {
  return typeof value === "string" && ANALYTICS_ROOM_ID_PATTERN.test(value)
}

/**
 * #346: coarse Task duration band. Returns undefined for a duration that
 * cannot be truthfully derived (missing, non-finite, or negative — the last
 * only possible through a backwards clock step). Callers OMIT the property
 * in that case rather than fabricating one.
 *
 * Boundaries are inclusive-lower: exactly 60s is "1-5m", exactly 5m is
 * "5-15m", exactly 15m is "15-60m", exactly 60m is "60m+".
 */
export function taskDurationBucket(
  durationMs: number
): TaskDurationBucket | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined
  const minutes = durationMs / 60_000
  if (minutes < 1) return "<1m"
  if (minutes < 5) return "1-5m"
  if (minutes < 15) return "5-15m"
  if (minutes < 60) return "15-60m"
  return "60m+"
}

/**
 * #346: classify ONE accepted permission response into a low-cardinality
 * control value.
 *
 * The ACP protocol's `PermissionOption.kind` is the only stable,
 * truth-level field the Room holds (it is preserved verbatim on the
 * canonical request; Free4Chat never infers meaning from the display name or
 * from an opaque optionId). When kind is absent, or carries any value
 * outside the protocol's enum, the Room degenerates to a single
 * `permission-response` value rather than guessing allow/reject.
 */
export function permissionControlValue(
  optionKind: unknown
): Extract<
  TaskControl,
  "permission-allow" | "permission-reject" | "permission-response"
> {
  if (optionKind === "allow_once" || optionKind === "allow_always")
    return "permission-allow"
  if (optionKind === "reject_once" || optionKind === "reject_always")
    return "permission-reject"
  return "permission-response"
}

export function roomComposition(
  participants: Iterable<Pick<RoomParticipant, "kind">>
): RoomComposition {
  let humans = 0
  let agents = 0
  for (const participant of participants) {
    if (participant.kind === "human") humans += 1
    if (participant.kind === "agent") agents += 1
  }
  if (agents === 0) return "human-only"
  if (humans === 0) return "agent-only"
  return agents === 1 ? "human-agent" : "mixed"
}

export function participantsBucket(count: number): "1" | "2-3" | "4-9" | "10+" {
  if (count >= 10) return "10+"
  if (count >= 4) return "4-9"
  if (count >= 2) return "2-3"
  return "1"
}

export function resolveParticipantKind(
  participants: Iterable<Pick<RoomParticipant, "id" | "kind">>,
  participantId: string
): ResolvedParticipantKind {
  for (const participant of participants) {
    if (participant.id === participantId) return participant.kind
  }
  return "unknown"
}

/** Original delegation topology; outcomes reverse request direction. */
export function delegationTopology(
  kind: string,
  fromParticipantId: string,
  targetParticipantId: string
): { requesterId: string; targetId: string } {
  return kind === "request"
    ? { requesterId: fromParticipantId, targetId: targetParticipantId }
    : { requesterId: targetParticipantId, targetId: fromParticipantId }
}

export function buildAgentJoinedEvent(args: {
  roomName: string
  analyticsRoomId: string
  participants: RoomParticipant[]
}): RoomAnalyticsEvent {
  return {
    name: "AgentJoined",
    properties: {
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      participantBucket: participantsBucket(args.participants.length),
      roomComposition: roomComposition(args.participants),
    },
  }
}

// #234: exactly one RoomCreated per canonical Room generation. creatorKind
// is the kind of the participant whose registration materialized the Room;
// creationSource is classified from the entry path (browser session,
// official Runtime User-Agent, or other MCP caller). Coarse telemetry only —
// it never affects authentication, authorization, or Room behavior.
// #346: analyticsRoomId is the id persisted WITH this generation, never a
// temporary value minted for the event.
export function buildRoomCreatedEvent(args: {
  roomName: string
  analyticsRoomId: string
  creatorKind: RoomCreatedCreatorKind
  creationSource: RoomCreationSource
}): RoomAnalyticsEvent {
  return {
    name: "RoomCreated",
    properties: {
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      creatorKind: args.creatorKind,
      creationSource: args.creationSource,
    },
  }
}

export function buildCollabRequestedEvent(args: {
  roomName: string
  analyticsRoomId: string
  participants: RoomParticipant[]
  fromParticipantId: string
  targetParticipantId: string
}): RoomAnalyticsEvent {
  const topology = delegationTopology(
    "request",
    args.fromParticipantId,
    args.targetParticipantId
  )
  return {
    name: "CollabRequested",
    properties: {
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      requesterKind: resolveParticipantKind(
        args.participants,
        topology.requesterId
      ),
      targetKind: resolveParticipantKind(args.participants, topology.targetId),
      roomComposition: roomComposition(args.participants),
    },
  }
}

/**
 * #346: terminal collaboration outcome. `hasArtifact` is the pre-existing
 * property and keeps its exact semantics (the terminal envelope carried at
 * least one referenced attachment id).
 *
 * The additions are bounded product-value flags derived from canonical
 * Room state correlated by the SAME taskRequestId that identifies this
 * collaboration request — never from another Task's state:
 *
 *   hasLiveView     this Task's own current Live View snapshot exists
 *   hasGeneratedApp a generated Room App publication names this Task
 *   durationBucket  coarse band from the retained canonical request
 *                   message's createdAt to the canonical terminal time;
 *                   omitted when the request has fallen outside the bounded
 *                   message ring (no Task timing database is invented)
 *
 * Requester/target ids, request ids, attachment ids, surface ids, and app
 * instance ids never cross this boundary.
 */
export function buildCollabOutcomeEvent(args: {
  roomName: string
  analyticsRoomId: string
  participants: RoomParticipant[]
  kind: "declined" | "completed" | "failed"
  fromParticipantId: string
  targetParticipantId: string
  attachmentIds?: string[]
  requestCreatedAt?: number
  completedAt?: number
  hasLiveView?: boolean
  hasGeneratedApp?: boolean
}): RoomAnalyticsEvent {
  const topology = delegationTopology(
    "outcome",
    args.fromParticipantId,
    args.targetParticipantId
  )
  const durationBucket =
    args.requestCreatedAt === undefined || args.completedAt === undefined
      ? undefined
      : taskDurationBucket(args.completedAt - args.requestCreatedAt)
  return {
    name: "CollabOutcome",
    properties: {
      outcome: args.kind,
      requesterKind: resolveParticipantKind(
        args.participants,
        topology.requesterId
      ),
      targetKind: resolveParticipantKind(args.participants, topology.targetId),
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      hasArtifact: Array.isArray(args.attachmentIds)
        ? args.attachmentIds.length > 0
        : false,
      ...(durationBucket === undefined ? {} : { durationBucket }),
      hasLiveView: args.hasLiveView === true,
      hasGeneratedApp: args.hasGeneratedApp === true,
      roomComposition: roomComposition(args.participants),
    },
  }
}

export function buildCollaborationDurationEvent(args: {
  roomName: string
  analyticsRoomId: string
  durationMs: number
  collaborationMode: "human-only" | "agent-only" | "human-agent"
  participantBucket: "1" | "2-3" | "4-9" | "10+"
}): RoomAnalyticsEvent {
  return {
    name: "CollaborationDuration",
    properties: {
      durationMs: args.durationMs,
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      collaborationMode: args.collaborationMode,
      participantBucket: args.participantBucket,
    },
  }
}

// #234: natural-collaboration topology. One canonical accepted TEXT message
// with explicit Room targets emits exactly one TargetedMessage (never one
// per recipient); unaddressed text and structured collab action envelopes
// emit none (CollabRequested/Outcome stay authoritative for the correlated
// lifecycle). The Room append already validated every target as a CURRENT
// participant ID (normalizeChatTargets/agentTextTargets keep only present
// Agent participants), so kind resolution below is exact today; if a target
// ever resolves unknown (possible only if the invariant broadens), it is
// treated conservatively as agent — the protocol's current target universe —
// rather than inventing a new kind.
export function buildTargetedMessageEvent(args: {
  roomName: string
  analyticsRoomId: string
  participants: RoomParticipant[]
  senderParticipantId: string
  targetParticipantIds: string[]
}): RoomAnalyticsEvent {
  const kinds = new Set(
    args.targetParticipantIds.map((id) =>
      resolveParticipantKind(args.participants, id)
    )
  )
  const targetKind: "human" | "agent" | "mixed" =
    kinds.has("human") && kinds.has("agent")
      ? "mixed"
      : kinds.has("human")
      ? "human"
      : "agent"
  return {
    name: "TargetedMessage",
    properties: {
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      senderKind: resolveParticipantKind(
        args.participants,
        args.senderParticipantId
      ),
      targetKind,
      targetCountBucket: participantsBucket(args.targetParticipantIds.length),
      roomComposition: roomComposition(args.participants),
    },
  }
}

export function buildLiveViewPublishedEvent(args: {
  roomName: string
  analyticsRoomId: string
  participants: RoomParticipant[]
  phase: "first" | "replacement"
}): RoomAnalyticsEvent {
  return {
    name: "LiveViewPublished",
    properties: {
      phase: args.phase,
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      participantBucket: participantsBucket(args.participants.length),
      roomComposition: roomComposition(args.participants),
    },
  }
}

export function generatedBundleSizeBucket(
  bytes: number
): "0-4k" | "4-16k" | "16-32k" | "32-48k" {
  if (bytes <= 4 * 1024) return "0-4k"
  if (bytes <= 16 * 1024) return "4-16k"
  if (bytes <= 32 * 1024) return "16-32k"
  return "32-48k"
}

export function buildGeneratedRoomAppPublishedEvent(args: {
  roomName: string
  analyticsRoomId: string
  participants: RoomParticipant[]
  phase: "first" | "update"
  bundleBytes: number
}): RoomAnalyticsEvent {
  return {
    name: "RoomAppPublished",
    properties: {
      appSource: "generated",
      phase: args.phase,
      bundleSizeBucket: generatedBundleSizeBucket(args.bundleBytes),
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      participantBucket: participantsBucket(args.participants.length),
      roomComposition: roomComposition(args.participants),
    },
  }
}

/**
 * #346: exactly one event per ACCEPTED canonical supervision control. Emitted
 * only after the Room has performed the action (an accepted interrupt
 * delivered to the canonical Agent endpoint, a canonical Task created by a
 * successful session continuation, an accepted permission resolution) — never
 * from a click, an impression, a disabled control, a rejected/unauthorized
 * attempt, or a malformed request.
 *
 * Properties stay minimal on purpose: taskRequestId, turnSequence, permission
 * request/option ids, session tokens, participant ids, and instruction text
 * are all deliberately absent.
 */
export function buildTaskControlUsedEvent(args: {
  roomName: string
  analyticsRoomId: string
  participants: RoomParticipant[]
  control: TaskControl
}): RoomAnalyticsEvent {
  return {
    name: "TaskControlUsed",
    properties: {
      control: args.control,
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      analyticsRoomId: args.analyticsRoomId,
      roomComposition: roomComposition(args.participants),
    },
  }
}

/**
 * Advance the OPEN 2+-participant collaboration interval (#228 extension).
 * Count is the number of CURRENT canonical participants in the Room record.
 * - count reaches 2 with no open interval -> interval opens at `now`.
 * - open interval and count stays >= 2 -> sawHuman/sawAgent/peak update;
 *   no duration event (composition changes never manufacture one).
 * - count falls below 2 with an open interval -> interval closes and ONE
 *   duration summary is returned (retention time after the closing
 *   departure is never counted).
 * Eviction/restart survives because the state rides persisted Room state.
 */
export function transitionCollaborationActivity(
  participants: Iterable<Pick<RoomParticipant, "id" | "kind">>,
  existing: CollaborationActivity | undefined,
  now: number
): {
  activity: CollaborationActivity | undefined
  summary: CollaborationDurationSummary | null
} {
  const list = Array.from(participants)
  const count = list.length
  const sawHuman =
    (existing?.sawHuman ?? false) || list.some((p) => p.kind === "human")
  const sawAgent =
    (existing?.sawAgent ?? false) || list.some((p) => p.kind === "agent")
  const peak = Math.max(existing?.peakParticipantCount ?? 0, count)

  if (count >= 2) {
    const startedAt = existing?.startedAt ?? now
    return {
      activity: {
        startedAt,
        sawHuman,
        sawAgent,
        peakParticipantCount: Math.max(2, peak),
      },
      summary: null,
    }
  }
  if (!existing) return { activity: undefined, summary: null }
  const collaborationMode =
    sawHuman && sawAgent
      ? "human-agent"
      : sawAgent
      ? "agent-only"
      : "human-only"
  return {
    activity: undefined,
    summary: {
      durationMs: Math.max(0, now - existing.startedAt),
      collaborationMode,
      participantBucket: participantsBucket(existing.peakParticipantCount),
    },
  }
}

export function normalizeStoredCollaborationActivity(
  input: unknown
): CollaborationActivity | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const candidate = input as Record<string, unknown>
  const startedAt = candidate.startedAt
  if (typeof startedAt !== "number" || !(startedAt > 0)) return undefined
  if (typeof candidate.sawHuman !== "boolean") return undefined
  if (typeof candidate.sawAgent !== "boolean") return undefined
  const peak = candidate.peakParticipantCount
  if (typeof peak !== "number" || !(peak >= 2) || !(peak <= 999)) {
    return undefined
  }
  return {
    startedAt,
    sawHuman: candidate.sawHuman as boolean,
    sawAgent: candidate.sawAgent as boolean,
    peakParticipantCount: peak,
  }
}

/** The only properties each event may carry (#228 schema freeze).
 * #346: every Room-scoped event dual-writes `roomHash` (historical report
 * compatibility) and `analyticsRoomId` (canonical generation correlation). */
export const APPROVED_ANALYTICS_PROPERTIES: Record<
  RoomAnalyticsEvent["name"],
  readonly string[]
> = {
  AgentJoined: [
    "roomType",
    "roomHash",
    "analyticsRoomId",
    "participantBucket",
    "roomComposition",
  ],
  RoomCreated: ["roomHash", "analyticsRoomId", "creatorKind", "creationSource"],
  TargetedMessage: [
    "roomType",
    "roomHash",
    "analyticsRoomId",
    "senderKind",
    "targetKind",
    "targetCountBucket",
    "roomComposition",
  ],
  CollaborationDuration: [
    "durationMs",
    "roomType",
    "roomHash",
    "analyticsRoomId",
    "collaborationMode",
    "participantBucket",
  ],
  CollabRequested: [
    "roomType",
    "roomHash",
    "analyticsRoomId",
    "requesterKind",
    "targetKind",
    "roomComposition",
  ],
  CollabOutcome: [
    "outcome",
    "requesterKind",
    "targetKind",
    "roomType",
    "roomHash",
    "analyticsRoomId",
    "hasArtifact",
    "durationBucket",
    "hasLiveView",
    "hasGeneratedApp",
    "roomComposition",
  ],
  LiveViewPublished: [
    "phase",
    "roomType",
    "roomHash",
    "analyticsRoomId",
    "participantBucket",
    "roomComposition",
  ],
  RoomAppPublished: [
    "appSource",
    "phase",
    "bundleSizeBucket",
    "roomType",
    "roomHash",
    "analyticsRoomId",
    "participantBucket",
    "roomComposition",
  ],
  TaskControlUsed: [
    "control",
    "roomType",
    "roomHash",
    "analyticsRoomId",
    "roomComposition",
  ],
}

/**
 * Build one Mixpanel /import row. Only approved properties ride; the
 * aggregate server identity is intentional (unique-user math on these
 * events is meaningless — the board uses totals/composition/topology).
 */
export function mixpanelImportRow(
  event: RoomAnalyticsEvent,
  nowMs: number,
  insertId: string
): Record<string, unknown> {
  const approved = APPROVED_ANALYTICS_PROPERTIES[event.name]
  const properties: Record<string, unknown> = {
    time: nowMs,
    distinct_id: SERVER_DISTINCT_ID,
    $insert_id: insertId,
    ip: 0,
  }
  for (const key of approved) {
    if (event.properties[key] !== undefined)
      properties[key] = event.properties[key]
  }
  return { event: event.name, properties }
}

/**
 * Best-effort Mixpanel /import ingestion. Absent token -> silent no-op;
 * any failure -> a coarse warning only. Never throws, never returns
 * request/response internals.
 */
export async function importAnalyticsEvents(
  events: RoomAnalyticsEvent[],
  projectToken: string | undefined,
  fetchImpl: typeof fetch,
  nowMs: number
): Promise<void> {
  if (!projectToken || events.length === 0) return
  try {
    const rows = events.map((event) =>
      mixpanelImportRow(event, nowMs, crypto.randomUUID())
    )
    const response = await fetchImpl(MIXPANEL_IMPORT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Basic " + btoa(projectToken + ":"),
      },
      body: JSON.stringify(rows),
    })
    if (!response.ok) {
      console.warn("collab analytics ingestion unavailable")
    }
  } catch {
    console.warn("collab analytics ingestion unavailable")
  }
}
