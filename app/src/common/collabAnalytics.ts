import type { UserInfo } from "./types"
import { participantsBucket } from "./utils"
import type { CollabEvent } from "../room/types"

/**
 * Browser-side, evidence-oriented analytics for the Human + Agent
 * collaboration lifecycle (#106 lifecycle, #155 funnel). Events are derived
 * from the canonical, already-deduplicated Room state a connected Human
 * browser observes — the participant roster and persisted collaboration
 * envelopes — never from button clicks or transient UI state.
 *
 * Privacy: payloads are intentionally coarse. Room names are hashed with the
 * shared hashRoom helper; participant kinds and counts are bucketed. Request
 * summaries, capability strings, participant names, and raw request or
 * participant ids never cross this module's output.
 */

export type RoomComposition =
  | "human-agent"
  | "agent-only"
  | "mixed"
  | "human-only"

export type ResolvedParticipantKind = "human" | "agent" | "unknown"

export interface AgentJoinedPayload {
  roomType: string
  roomHash: string
  participantBucket: string
  roomComposition: RoomComposition
  [key: string]: unknown
}

export interface CollabRequestedPayload {
  roomType: string
  roomHash: string
  requesterKind: ResolvedParticipantKind
  targetKind: ResolvedParticipantKind
  roomComposition: RoomComposition
  [key: string]: unknown
}

export interface CollabOutcomePayload {
  outcome: "completed" | "failed" | "declined"
  requesterKind: ResolvedParticipantKind
  targetKind: ResolvedParticipantKind
  roomType: string
  roomHash: string
  hasArtifact: boolean
  roomComposition: RoomComposition
  [key: string]: unknown
}

export type CollabAnalyticsEmission =
  | { name: "CollabRequested"; properties: CollabRequestedPayload }
  | { name: "CollabOutcome"; properties: CollabOutcomePayload }

export interface CollabAnalyticsContext {
  roomType: string
  roomHash: string
  /** Current connected roster (server-authoritative presence). */
  participants: Array<Pick<UserInfo, "peerId" | "kind">>
  /** The browser's own roster entry (LOCAL_PEER_ID); always the Human. */
  selfPeerId: string
  /** The browser's raw Room participant id, when the session has one. */
  selfParticipantId?: string
}

const AGENT_JOINED_PROPERTIES = [
  "roomType",
  "roomHash",
  "participantBucket",
  "roomComposition",
] as const

const COLLAB_REQUESTED_PROPERTIES = [
  "roomType",
  "roomHash",
  "requesterKind",
  "targetKind",
  "roomComposition",
] as const

const COLLAB_OUTCOME_PROPERTIES = [
  "outcome",
  "requesterKind",
  "targetKind",
  "roomType",
  "roomHash",
  "hasArtifact",
  "roomComposition",
] as const

export function roomComposition(
  participants: Array<Pick<UserInfo, "kind">>
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

export function resolveParticipantKind(
  context: CollabAnalyticsContext,
  participantId: string
): ResolvedParticipantKind {
  if (
    context.selfParticipantId !== undefined &&
    participantId === context.selfParticipantId
  ) {
    return "human"
  }
  if (participantId === context.selfPeerId) return "human"
  const participant = context.participants.find(
    (entry) => entry.peerId === participantId
  )
  return participant?.kind ?? "unknown"
}

export interface CollabAnalyticsTracker {
  /**
   * Observe the current roster. Returns one payload per Agent participant
   * id seen for the first time by this browser session; replay, reconnect,
   * and re-render of already-seen participants return an empty array.
   */
  observePresence(context: CollabAnalyticsContext): AgentJoinedPayload[]
  /**
   * Observe one canonical collaboration envelope from Room state. Returns
   * at most one analytics event per canonical requestId per browser
   * session: the first observation of a request emits CollabRequested, the
   * first observation of a terminal kind (declined/completed/failed) emits
   * CollabOutcome, and every later observation of either returns null.
   * accepted is an intermediate lifecycle kind and never emits.
   */
  observeCollabEvent(
    context: CollabAnalyticsContext,
    event: CollabEvent
  ): CollabAnalyticsEmission | null
}

export function createCollabAnalyticsTracker(): CollabAnalyticsTracker {
  const seenAgentParticipantIds = new Set<string>()
  const seenRequestIds = new Set<string>()
  const seenOutcomeRequestIds = new Set<string>()

  return {
    observePresence(context) {
      const joined: AgentJoinedPayload[] = []
      for (const participant of context.participants) {
        if (participant.kind !== "agent") continue
        if (seenAgentParticipantIds.has(participant.peerId)) continue
        seenAgentParticipantIds.add(participant.peerId)
        joined.push({
          roomType: context.roomType,
          roomHash: context.roomHash,
          participantBucket: participantsBucket(context.participants.length),
          roomComposition: roomComposition(context.participants),
        })
      }
      return joined
    },

    observeCollabEvent(context, event) {
      if (event.kind === "accepted") return null

      if (event.kind === "request") {
        // A request that already reached a terminal outcome in this session
        // cannot rebuild the funnel; do not emit an out-of-order event.
        if (
          seenRequestIds.has(event.requestId) ||
          seenOutcomeRequestIds.has(event.requestId)
        ) {
          return null
        }
        seenRequestIds.add(event.requestId)
        const properties: CollabRequestedPayload = {
          roomType: context.roomType,
          roomHash: context.roomHash,
          requesterKind: resolveParticipantKind(
            context,
            event.fromParticipantId
          ),
          targetKind: resolveParticipantKind(
            context,
            event.targetParticipantId
          ),
          roomComposition: roomComposition(context.participants),
        }
        return { name: "CollabRequested", properties }
      }

      // declined | completed | failed: terminal collaboration outcomes.
      if (seenOutcomeRequestIds.has(event.requestId)) return null
      seenOutcomeRequestIds.add(event.requestId)
      const properties: CollabOutcomePayload = {
        outcome: event.kind,
        requesterKind: resolveParticipantKind(context, event.fromParticipantId),
        targetKind: resolveParticipantKind(context, event.targetParticipantId),
        roomType: context.roomType,
        roomHash: context.roomHash,
        hasArtifact: Array.isArray(event.attachmentIds)
          ? event.attachmentIds.length > 0
          : false,
        roomComposition: roomComposition(context.participants),
      }
      return { name: "CollabOutcome", properties }
    },
  }
}

export const ANALYTICS_PROPERTY_KEYS = {
  AgentJoined: AGENT_JOINED_PROPERTIES,
  CollabRequested: COLLAB_REQUESTED_PROPERTIES,
  CollabOutcome: COLLAB_OUTCOME_PROPERTIES,
} as const
