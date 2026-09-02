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

export interface RoomAnalyticsEvent {
  name: "AgentJoined" | "CollabRequested" | "CollabOutcome"
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

/** The only properties each event may carry (#228 schema freeze). */
export const APPROVED_ANALYTICS_PROPERTIES: Record<
  RoomAnalyticsEvent["name"],
  readonly string[]
> = {
  AgentJoined: ["roomType", "roomHash", "participantBucket", "roomComposition"],
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
