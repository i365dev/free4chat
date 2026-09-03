import type { RoomParticipant } from "../room/types"

/**
 * #228: Room-authoritative collaboration-truth analytics. These three
 * canonical events (AgentJoined / CollabRequested / CollabOutcome) move from
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
    | "TargetedMessage"
    | "CollabRequested"
    | "CollabOutcome"
    | "CollaborationDuration"
  properties: Record<string, unknown>
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
  participants: RoomParticipant[]
}): RoomAnalyticsEvent {
  return {
    name: "AgentJoined",
    properties: {
      roomType: "unknown",
      roomHash: hashRoom(args.roomName),
      participantBucket: participantsBucket(args.participants.length),
      roomComposition: roomComposition(args.participants),
    },
  }
}

export function buildCollabRequestedEvent(args: {
  roomName: string
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
      requesterKind: resolveParticipantKind(
        args.participants,
        topology.requesterId
      ),
      targetKind: resolveParticipantKind(args.participants, topology.targetId),
      roomComposition: roomComposition(args.participants),
    },
  }
}

export function buildCollabOutcomeEvent(args: {
  roomName: string
  participants: RoomParticipant[]
  kind: "declined" | "completed" | "failed"
  fromParticipantId: string
  targetParticipantId: string
  attachmentIds?: string[]
}): RoomAnalyticsEvent {
  const topology = delegationTopology(
    "outcome",
    args.fromParticipantId,
    args.targetParticipantId
  )
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
      hasArtifact: Array.isArray(args.attachmentIds)
        ? args.attachmentIds.length > 0
        : false,
      roomComposition: roomComposition(args.participants),
    },
  }
}

export function buildCollaborationDurationEvent(args: {
  roomName: string
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

/** The only properties each event may carry (#228 schema freeze). */
export const APPROVED_ANALYTICS_PROPERTIES: Record<
  RoomAnalyticsEvent["name"],
  readonly string[]
> = {
  AgentJoined: ["roomType", "roomHash", "participantBucket", "roomComposition"],
  TargetedMessage: [
    "roomType",
    "roomHash",
    "senderKind",
    "targetKind",
    "targetCountBucket",
    "roomComposition",
  ],
  CollaborationDuration: [
    "durationMs",
    "roomType",
    "roomHash",
    "collaborationMode",
    "participantBucket",
  ],
  CollabRequested: [
    "roomType",
    "roomHash",
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
    "hasArtifact",
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
