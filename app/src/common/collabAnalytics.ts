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
 * Observation baseline: facts that already existed when this browser began
 * observing the Room (Agents in the initial connected roster, collaboration
 * envelopes created before observation started) are recorded silently and
 * never emitted under this browser's analytics identity. Only facts that
 * become new after observation begins are emitted, and each is emitted at
 * most once per browser session — resync replay, reconnect, and re-render
 * never re-count.
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
  /**
   * True only while this observation reflects the initial post-join snapshot
   * (the connection is established). The tracker baselines Agents present in
   * that first snapshot instead of counting them as having just joined.
   */
  presenceBaseline?: boolean
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

/**
 * Normalize the canonical envelope routing to the ORIGINAL delegation
 * topology. Responses/results reverse direction: the registry rewrites them
 * as from=responder (the original target) and target=the original requester
 * (see do/collab.ts). requesterKind/targetKind must consistently mean the
 * original requester and target across CollabRequested and CollabOutcome.
 */
export function delegationTopology(event: CollabEvent): {
  requesterId: string
  targetId: string
} {
  return event.kind === "request"
    ? {
        requesterId: event.fromParticipantId,
        targetId: event.targetParticipantId,
      }
    : {
        requesterId: event.targetParticipantId,
        targetId: event.fromParticipantId,
      }
}

export interface CollabAnalyticsTracker {
  /**
   * Observe the current roster. The first observation flagged as the initial
   * post-join snapshot baselines every Agent present without emitting; after
   * that, each Agent participant id seen for the first time emits exactly
   * one payload, and replay/reconnect/re-render of known ids emit nothing.
   */
  observePresence(context: CollabAnalyticsContext): AgentJoinedPayload[]
  /**
   * Observe one canonical collaboration envelope from Room state with its
   * persisted createdAt. Envelopes created before this tracker's observation
   * began are historical: they are recorded silently so replays of retained
   * Room history never emit under this browser's identity. Otherwise, at
   * most one analytics event per canonical requestId per browser session:
   * the first new request emits CollabRequested, the first new terminal kind
   * (declined/completed/failed) emits CollabOutcome, and every later
   * observation of either returns null. accepted never emits.
   */
  observeCollabEvent(
    context: CollabAnalyticsContext,
    event: CollabEvent,
    createdAt?: number
  ): CollabAnalyticsEmission | null
}

export function createCollabAnalyticsTracker(): CollabAnalyticsTracker {
  const seenAgentParticipantIds = new Set<string>()
  const seenRequestIds = new Set<string>()
  const seenOutcomeRequestIds = new Set<string>()
  // Observation began when the browser mounted the Room; collab envelopes
  // carry the DO-side creation clock, so this boundary classifies retained
  // history as historical. Small client/server clock skew can only move the
  // edge by the skew amount — the same tradeoff the reaction precedent in
  // RoomContent accepts for its pre-join guard.
  const observationStartedAt = Date.now()
  let presenceBaselined = false

  return {
    observePresence(context) {
      if (!presenceBaselined) {
        if (context.presenceBaseline !== true) return []
        // Initial post-join snapshot: Agents already present did not "just
        // join" — record them silently and start observing for new joins.
        presenceBaselined = true
        for (const participant of context.participants) {
          if (participant.kind === "agent") {
            seenAgentParticipantIds.add(participant.peerId)
          }
        }
        return []
      }
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

    observeCollabEvent(context, event, createdAt) {
      if (event.kind === "accepted") return null

      // Retained history predating observation: seed the dedup sets so
      // replays of the same lifecycle can never emit, but stay silent.
      if (createdAt !== undefined && createdAt < observationStartedAt) {
        if (event.kind === "request") seenRequestIds.add(event.requestId)
        else seenOutcomeRequestIds.add(event.requestId)
        return null
      }

      const topology = delegationTopology(event)

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
          requesterKind: resolveParticipantKind(context, topology.requesterId),
          targetKind: resolveParticipantKind(context, topology.targetId),
          roomComposition: roomComposition(context.participants),
        }
        return { name: "CollabRequested", properties }
      }

      // declined | completed | failed: terminal collaboration outcomes.
      if (seenOutcomeRequestIds.has(event.requestId)) return null
      seenOutcomeRequestIds.add(event.requestId)
      const properties: CollabOutcomePayload = {
        outcome: event.kind,
        requesterKind: resolveParticipantKind(context, topology.requesterId),
        targetKind: resolveParticipantKind(context, topology.targetId),
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
