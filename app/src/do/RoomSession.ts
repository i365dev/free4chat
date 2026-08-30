import { DurableObject } from "cloudflare:workers"

import {
  agentCapabilitiesFrom,
  CollabRegistry,
  COLLAB_ACTION_TYPE,
  MAX_COLLAB_SUMMARY_LENGTH,
  rosterProjection,
  sanitizeStoredAdvertisedList,
  sanitizeStoredAgentCapabilities,
  validateAdvertisedCapabilities,
  validateCollabEvent,
  type CollabEventInput,
} from "./collab"
import {
  executeMediaCloseEffects,
  reconcileMediaCloseResults,
  snapshotMediaCloseEffects,
} from "./mediaEffects"
import {
  normalizeAgentVoiceParticipantMedia,
  normalizeMediaGrants,
  transitionAgentVoiceForRuntimeHostUpdate,
  transitionAgentVoiceSet,
  transitionMediaGrantsForParticipantDeparture,
  transitionMeetingNotesStart,
  transitionMeetingNotesStop,
  type AgentMediaRevocationIntent,
} from "./mediaGrantTransitions"
export { normalizeAgentVoiceParticipantMedia as normalizeAgentParticipantMedia } from "./mediaGrantTransitions"
import {
  agentMediaPermissions,
  isAgentAuthorizedForMedia,
  isAgentAuthorizedForSharedMedia,
  isAgentAuthorizedForVoice,
  NO_MEETING_NOTES,
  resolveAgentPurposePermission,
} from "./meetingNotesAuth"
import {
  isHumanAudioTrackTarget,
  pendingCleanupHasCapacity,
  queuePendingCleanup,
  stageAgentMediaRevocation,
  type AgentMediaRevocationDirection,
} from "./realtimeMedia"
import { computeExpiresAt, NO_EXPIRY } from "./roomExpiry"
import {
  garbageCollectRuntimeHosts,
  normalizeRuntimeHosts,
  projectRuntimeHosts,
  registerRuntimeHost,
  updateRuntimeHost,
  validateRuntimeHost,
} from "./runtimeHost"
import {
  createRuntimeHostProviderClaim,
  garbageCollectRuntimeHostProviders,
  normalizeRuntimeHostProviders,
  projectRuntimeHostProviders,
  redeemRuntimeHostProviderClaim,
  removeRuntimeHostProviderForHuman,
  verifyRuntimeHostProviderProof,
} from "./runtimeHostProvider"
import {
  SURFACE_CHUNK_SIZE,
  SURFACE_KEY_PREFIX,
  deleteSurfaceChunksBestEffort,
  evaluateSurfacePublish,
  sanitizeStoredSurface,
  surfaceChunkKey,
  swapSurfaceAfterPersist,
} from "./surface"
import {
  createRuntimeProviderHandle,
  hashRuntimeProviderHandle,
  isRuntimeProviderClaimHash,
} from "../common/runtimeProviderCredential"
import type {
  AgentCapabilities,
  AgentEvent,
  RoomCapabilities,
  RoomAttachment,
  MeetingNotesState,
  PendingMediaCleanup,
  RoomMediaTrack,
  AgentAttachmentMimeType,
  RoomMessage,
  RoomParticipant,
  RoomRecord,
  RoomState,
  ParticipantKind,
  RoomSurfaceV1,
  CollabEvent,
  RuntimeHostProjection,
} from "../room/types"

const RECONNECT_GRACE_MS = 30 * 1000
const AGENT_LEASE_MS = 90 * 1000
const MAX_MESSAGES = 100
const MAX_AGENT_ATTACHMENTS = 8
const MAX_AGENT_ATTACHMENT_BYTES = 768 * 1024
const ATTACHMENT_CHUNK_SIZE = 64 * 1024
const MAX_TARGETS = 8
// Bounded per-agent scratch state for server-side revocation (finding #3):
// one mid per Human audio track the note-taker Agent is currently
// subscribed to. Not a general media-session database — cleared to empty
// on every revocation (Stop, reassignment, leave, lease expiry). Enforced
// by *refusing* a new subscription that would exceed this rather than
// silently truncating older, still-active mids — see the
// "agent-track-subscribed" action.
const MAX_AGENT_SUBSCRIBED_MIDS = 64
// How soon to retry a failed Cloudflare tracks/close call (Blocker 1): must
// be much sooner than the lease/reconnect-driven alarm deadlines that
// otherwise dominate scheduleNextAlarm(), since a stuck pending cleanup
// means RTP may still be flowing to a revoked Agent.
const MEDIA_CLEANUP_RETRY_MS = 30 * 1000

const ROOM_CAPABILITIES: RoomCapabilities = {
  text: true,
  audio: true,
  screenShare: true,
  files: true,
  agentText: true,
  agentImages: true,
  agentTargeting: true,
}

// Shared addressing normalization (#165): keep current Agent participant
// IDs only, deduplicate, and bound the list. Targeting decides wakeup —
// never authorization. Anything malformed degrades to an ordinary
// unaddressed message instead of failing the send. excludeId lets the
// Agent path drop a target before the bound so a self-echo can never
// consume one of the slots.
function normalizeChatTargets(
  room: RoomRecord,
  rawTargets: unknown,
  excludeId?: string
): string[] {
  return [
    ...new Set(
      (Array.isArray(rawTargets) ? rawTargets : [])
        .filter((id): id is string => typeof id === "string")
        .filter((id) => room.participants[id]?.kind === "agent")
        .filter((id) => id !== excludeId)
    ),
  ].slice(0, MAX_TARGETS)
}

// Agent-originated send_text targets: the same Room addressing semantics as
// the Human chat path, plus one loop guard — an Agent can never target
// itself, so a Harness echoing its own participantId cannot wake itself
// into a reply loop.
function agentTextTargets(
  rawTargets: unknown,
  senderId: string,
  room: RoomRecord
): { targets: string[] } | {} {
  const targets = normalizeChatTargets(room, rawTargets, senderId)
  return targets.length ? { targets } : {}
}

export interface RoomSessionEnv {
  SFU_ROOM: DurableObjectNamespace<RoomSession>
  // RoomSession is bound within the same Worker as sfu/server.ts (see
  // wrangler.jsonc), so its runtime `env` is already the full Worker env —
  // these three are declared here only to widen the *type*, not because any
  // new binding/secret needs to be added. SFU_APP_ID/SFU_APP_SECRET are used
  // to actively close Cloudflare Realtime tracks on Meeting Notes
  // revocation (see realtimeMedia.ts); AGENT_MEDIA_ENABLED gates the
  // "meeting-notes-start" WS message the same way it already gates
  // agent-session/agent-room-media in sfu/server.ts, so the room-visible
  // grant can never claim "active" in an environment where every actual
  // Runtime media request would 403.
  SFU_APP_ID?: string
  SFU_APP_SECRET?: string
  AGENT_MEDIA_ENABLED?: string
}

interface ConnectionAttachment {
  participantId: string
  token: string
  connectionNonce: string
}

interface StoredParticipant extends RoomParticipant {
  sessionId?: string
  muted?: boolean
  fileChannelReady?: boolean
  tracks?: RoomMediaTrack[]
}

interface StoredRoom
  extends Omit<
    RoomRecord,
    | "participants"
    | "messages"
    | "attachments"
    | "nextMessageSequence"
    | "meetingNotes"
    | "agentVoice"
    | "pendingMediaCleanup"
    | "runtimeHostProviders"
    | "runtimeHostProviderClaims"
  > {
  participants: Record<string, StoredParticipant>
  messages: Array<Omit<RoomMessage, "sequence"> & { sequence?: number }>
  attachments?: RoomAttachment[]
  nextMessageSequence?: number
  meetingNotes?: MeetingNotesState
  // Legacy singleton state is read only to fail closed during migration.
  voiceReply?: unknown
  agentVoice?: unknown
  pendingMediaCleanup?: PendingMediaCleanup[]
  runtimeHostProviders?: unknown
  runtimeHostProviderClaims?: unknown
}

interface AgentWaiter {
  participantId: string
  cursor: number
  resolve: (response: Response) => void
  timer: ReturnType<typeof setTimeout>
}

type ControlRequest =
  | {
      action: "register"
      participant: Omit<RoomParticipant, "connected" | "lastSeenAt"> & {
        // Humans never project a Runtime Host; any payload is dropped.
        runtimeHost?: RuntimeHostProjection
      }
    }
  | {
      action: "authorize"
      participantId: string
      token: string
      sessionId?: string
      trackSessionId?: string
      trackName?: string
      dataChannelSessionId?: string
      // Round 5 (P2): when set, an Agent caller about to request this many
      // new remote-subscribe tracks from Cloudflare is also preflight-
      // checked for pending-cleanup and active-mid capacity here — before
      // any Cloudflare tracks/new call is made. Ignored for Human callers.
      remoteTrackCount?: number
      purpose?: unknown
      wantsVoicePublish?: boolean
      localTrackCount?: number
    }
  | {
      action: "agent-track-published"
      participantId: string
      token: string
      sessionId: string
      mid: string
      trackName: string
      // Runtime may defer the public trackPublished broadcast until its
      // bounded silent priming packet has reached Cloudflare. This prevents a
      // Human from attempting tracks/new against a still-inactive booking.
      announce?: boolean
    }
  | {
      action: "agent-track-active"
      participantId: string
      token: string
      sessionId: string
      trackName: string
    }
  | {
      action: "agent-track-ready"
      participantId: string
      token: string
      sessionId: string
      trackName: string
    }
  | {
      action: "reconnect"
      participantId: string
      token: string
      sessionId: string
      newSessionId: string
    }
  | {
      action: "publish"
      participantId: string
      token: string
      track: RoomMediaTrack
    }
  | {
      action: "unpublish"
      participantId: string
      token: string
      trackName: string
    }
  | {
      action: "leave"
      participantId: string
      token: string
    }
  | { action: "room-info"; participantId?: string }
  | {
      action: "agent-register"
      // #176 Phase A wire shape: the Runtime Host arrives as a full
      // projection; the DO canonicalizes it into runtimeHosts +
      // participant.runtimeHostId (the raw object never persists).
      participant: Omit<
        RoomParticipant,
        "connected" | "lastSeenAt" | "runtimeHostId"
      > & {
        runtimeHost?: RuntimeHostProjection
        // Private registration material; never persisted on the participant.
        providerClaimHash?: string
        runtimeProviderHandle?: string
      }
    }
  | {
      // #51: atomic CREATE-ONLY room creation. The DO refuses when any room
      // state already exists under this id (even expired-but-unswept state,
      // which is expired first and still rejected for this attempt) — the
      // MCP layer owns bounded retry with fresh ids. Never falls back to
      // joining an existing room.
      action: "agent-create-room"
      // #178 review fix 3: create NEVER carries a runtimeHost — the
      // Room-scoped id is derived from the final server-generated roomId
      // after creation and pushed via agent-update-runtime-host.
      participant: Omit<RoomParticipant, "connected" | "lastSeenAt">
    }
  | {
      action: "agent-wait"
      participantId: string
      token: string
      cursor: number
      timeoutSeconds: number
    }
  | {
      action: "agent-send-text"
      participantId: string
      token: string
      text: string
      // #165: optional explicit addressing carried by the same Room
      // primitive the Human chat path uses. Participant IDs only — the DO
      // normalizes, drops non-Agent/self targets, and persists at most
      // MAX_TARGETS; targeting controls wakeup only, never authorization.
      targetParticipantIds?: unknown
    }
  | {
      // #106 Phase A: full replacement of this agent's advertised capability
      // list. Rejected (not repaired) on invalid input so a misbehaving
      // Runtime fails loudly instead of advertising a wrong self-image.
      action: "agent-update-capabilities"
      participantId: string
      token: string
      capabilities: string[]
    }
  | {
      // #176 Phase A: re-project this Agent's Runtime Host identity and
      // coarse speech readiness (speech hot reload path). Same loud-failure
      // contract as capabilities: invalid input is rejected, never repaired.
      action: "agent-update-runtime-host"
      participantId: string
      token: string
      runtimeHost: RuntimeHostProjection
      runtimeProviderHandle?: string
    }
  | {
      // #106 Phase B: one structured collaboration envelope. The request kind
      // targets a live participant; responses/results are correlated to the
      // tracked request by CollabRegistry before anything is broadcast.
      action: "agent-send-collab"
      participantId: string
      token: string
      event: CollabEventInput
    }
  | {
      action: "agent-read-attachment"
      participantId: string
      token: string
      attachmentId: string
    }
  | {
      // #117: authenticated CURRENT Human browser reads an existing room
      // attachment (observation only — no message, no wake, no collab
      // state change). Membership is the authorization.
      action: "human-read-attachment"
      participantId: string
      token: string
      attachmentId: string
    }
  | {
      action: "agent-leave"
      participantId: string
      token: string
    }
  | {
      action: "agent-clear-surface"
      participantId: string
      token: string
    }
  | {
      // #111: reads the CURRENT workspace snapshot of another participant.
      // Any authenticated current participant may read; a snapshotId that no
      // longer matches returns surface_changed (never stale bytes).
      action: "agent-read-surface"
      participantId: string
      token: string
      sourceParticipantId: string
      snapshotId: string
    }
  | {
      action: "agent-media-attach"
      participantId: string
      token: string
      sessionId: string
    }
  | {
      // #83 review: narrow admission probe for the ONE shared Agent SFU
      // session (agent-session route). Admits on meetingNotes OR voiceReply;
      // unlike agent-room-media it returns NO media state at all.
      action: "agent-media-admit"
      participantId: string
      token: string
    }
  | {
      action: "agent-room-media"
      participantId: string
      token: string
    }
  | {
      action: "agent-track-subscribed"
      participantId: string
      token: string
      sessionId: string
      mids: string[]
    }
  | {
      // Hand-off for the /api/sfu/tracks TOCTOU close-on-reject path
      // (Blocker 2): the Worker already attempted to close a
      // just-created-but-now-unauthorized Agent subscription itself; if
      // that close call didn't confirm success, this queues it for retry.
      // No participantId/token — the Agent may already have left/expired
      // by the time this arrives, and sessionId/mids are self-contained.
      action: "agent-media-cleanup-pending"
      sessionId: string
      mids: string[]
    }

type ClientMessage =
  | { type: "chat"; text: string; targets?: string[] }
  | {
      type: "action"
      actionType: string
      actionPayload?: Record<string, string>
    }
  | {
      // #113: Human-originated structured work request. Sender identity is
      // derived from the authenticated WebSocket attachment, never the
      // payload. Same CollabEvent/CollabRegistry path as Agent→Agent.
      type: "collab-request"
      requestId: string
      targetParticipantId: string
      summary: string
      attachmentIds?: string[]
    }
  | {
      // #115: Human accepted/declined for an Agent-originated request whose
      // target was THIS Human. Responder identity/routing derive from the
      // authenticated attachment + CollabRegistry correlation.
      type: "collab-response"
      requestId: string
      decision: "accepted" | "declined"
      summary?: string
    }
  | {
      // #121: Human terminal result (completed | failed) for an
      // Agent-originated request this Human previously accepted. Identity
      // and routing derive from the attachment + CollabRegistry; v0 payload
      // carries no details/attachmentIds.
      type: "collab-result"
      requestId: string
      status: "completed" | "failed"
      summary: string
    }
  | {
      // #119: Human self-advertised capability list replacement (discovery
      // metadata only). Identity from the authenticated attachment; payload
      // carries ONLY the capability tokens.
      type: "human-update-capabilities"
      capabilities: string[]
    }
  | { type: "mute"; muted: boolean }
  | { type: "unpublish"; trackName: string }
  | { type: "datachannel-ready" }
  | { type: "resync" }
  | { type: "leave" }
  | { type: "meeting-notes-start"; agentParticipantId: string }
  | { type: "meeting-notes-stop" }
  | {
      type: "agent-voice-set"
      agentParticipantId: string
      enabled: boolean
    }
  | {
      // Human-side acknowledgement after the Agent Voice remote subscription
      // has completed tracks/new + answer + renegotiate. The identifiers are
      // checked against the current private publication before readiness is
      // recorded; stale/duplicate acknowledgements are harmless.
      type: "agent-voice-ready"
      agentParticipantId: string
      sessionId: string
      trackName: string
    }
  | {
      // Browser-generated raw claim secrets never enter this message. The
      // server stores only the derived hash after authenticating the Human
      // from the WebSocket attachment.
      type: "runtime-provider-claim-create"
      requestId: string
      providerClaimHash: string
    }

export class RoomSession extends DurableObject<RoomSessionEnv> {
  // A participant has at most one outstanding long-poll. A null value is a
  // short-lived reservation while the request refreshes its lease.
  private readonly agentWaiters = new Map<string, AgentWaiter | null>()
  // #106 Phase B: room-lifetime collaboration bookkeeping (request
  // correlation + retried-send dedup). In-memory by design — see CollabRegistry.
  // Recoverable: rebuilt from the durable room.messages log on first use
  // after an eviction/restart (collabRebuilt flag below).
  private readonly collabRegistry = new CollabRegistry()
  private collabRebuilt = false

  // Correlation must never leak across room generations on the same DO
  // instance (a recycled room name after expiry would otherwise inherit
  // stale requestIds), so tracking resets whenever the room is recreated.
  private resetCollabTracking(): void {
    this.collabRegistry.clear()
    this.collabRebuilt = false
  }

  // Restores routing/dedup state from the bounded durable message log once
  // per DO instance lifetime (no-op afterwards): after eviction/restart the
  // registry starts empty and this replays actionType "collab" messages so
  // late responses still correlate and retried sends still collapse.
  private warmCollabRegistry(room: RoomRecord): void {
    if (this.collabRebuilt) return
    const entries = room.messages
      .filter(
        (message) => message.actionType === COLLAB_ACTION_TYPE && message.collab
      )
      .map((message) => ({
        event: message.collab!,
        sequence: message.sequence,
      }))
    this.collabRegistry.rebuild(entries)
    this.collabRebuilt = true
  }

  private async loadRoom(): Promise<RoomRecord | null> {
    const stored = await this.ctx.storage.get<StoredRoom>("room")
    if (!stored) return null
    const normalized = this.normalizeRoom(stored)
    if (normalized.changed) {
      // A legacy-voice migration may have staged an already-flowing RTP mid.
      // Persist and arm the short cleanup retry before this normalized Room
      // state is ever returned to a caller; do not fetch here, because that
      // would leave the caller holding a stale RoomRecord across I/O.
      await this.saveRoom(normalized.room)
      await this.scheduleNextAlarm(normalized.room)
    }
    return normalized.room
  }

  private normalizeRoom(stored: StoredRoom): {
    room: RoomRecord
    changed: boolean
  } {
    let changed = false
    const participants: Record<string, RoomParticipant> = {}

    for (const [id, rawParticipant] of Object.entries(stored.participants)) {
      const participant = { ...rawParticipant } as StoredParticipant
      if (participant.kind === "agent") {
        // An agent participant may optionally carry a subscribe-only media
        // session (see the "agent-media-attach" action) — unlike a human's,
        // it is never populated from tracks/muted/fileChannelReady legacy
        // fields, since an agent never publishes in the current protocol.
        const sanitized = sanitizeStoredAgentCapabilities(
          participant.capabilities
        )
        if (sanitized.changed) {
          participant.capabilities = sanitized.capabilities
          changed = true
        }
        // #111 storage hygiene: a malformed persisted surface is dropped
        // (never rejected) so room loading cannot wedge.
        const sanitizedSurface = sanitizeStoredSurface(participant.surface)
        if (sanitizedSurface.changed) {
          if (sanitizedSurface.surface)
            participant.surface = sanitizedSurface.surface
          else delete participant.surface
          changed = true
        }
        for (const key of [
          "sessionId",
          "muted",
          "fileChannelReady",
          "tracks",
        ] as const) {
          if (key in participant) {
            delete participant[key]
            changed = true
          }
        }
        if (participant.media?.agentSubscribedMids !== undefined) {
          const validMids = Array.isArray(participant.media.agentSubscribedMids)
            ? participant.media.agentSubscribedMids
                .filter((mid) => typeof mid === "string" && mid.length > 0)
                .slice(-MAX_AGENT_SUBSCRIBED_MIDS)
            : []
          if (
            validMids.length !== participant.media.agentSubscribedMids.length
          ) {
            participant.media = {
              ...participant.media,
              agentSubscribedMids: validMids,
            }
            changed = true
          }
        }
      } else if (!participant.media && participant.sessionId) {
        participant.media = {
          sessionId: participant.sessionId,
          muted: participant.muted === true,
          fileChannelReady: participant.fileChannelReady === true,
          tracks: participant.tracks ?? [],
        }
        delete participant.sessionId
        delete participant.muted
        delete participant.fileChannelReady
        delete participant.tracks
        changed = true
      }
      // #119 storage hygiene: malformed persisted Human advertised lists are
      // repaired/dropped (never rejected) so room loading cannot wedge.
      if (participant.kind === "human") {
        const sanitizedAdvertised = sanitizeStoredAdvertisedList(
          participant.advertised
        )
        if (sanitizedAdvertised.changed) {
          if (sanitizedAdvertised.advertised)
            participant.advertised = sanitizedAdvertised.advertised
          else delete participant.advertised
          changed = true
        } else if (
          sanitizedAdvertised.advertised &&
          sanitizedAdvertised.advertised.length === 0
        ) {
          delete participant.advertised
          changed = true
        }
      }
      participants[id] = participant
    }

    let nextMessageSequence =
      typeof stored.nextMessageSequence === "number" &&
      Number.isSafeInteger(stored.nextMessageSequence) &&
      stored.nextMessageSequence >= 0
        ? stored.nextMessageSequence
        : 0
    const messages: RoomMessage[] = []
    for (const rawMessage of stored.messages ?? []) {
      const sequence =
        typeof rawMessage.sequence === "number" &&
        Number.isSafeInteger(rawMessage.sequence) &&
        rawMessage.sequence > 0
          ? rawMessage.sequence
          : nextMessageSequence + 1
      if (rawMessage.sequence !== sequence) changed = true
      if (sequence > nextMessageSequence) nextMessageSequence = sequence
      const targets = Array.isArray(rawMessage.targets)
        ? [
            ...new Set(
              rawMessage.targets.filter((id) => typeof id === "string")
            ),
          ].slice(0, MAX_TARGETS)
        : undefined
      if (targets?.length !== rawMessage.targets?.length) changed = true
      messages.push({
        ...rawMessage,
        sequence,
        ...(targets?.length ? { targets } : {}),
      })
    }
    // #176 Phase A (canonical model) storage hygiene: keep ONE sanitized
    // readiness projection per Runtime Host id, then clear participant ids
    // that dangle after sanitization. The domain module owns both halves of
    // this repair so the Room loader does not duplicate Runtime Host rules.
    const normalizedRuntimeHosts = normalizeRuntimeHosts(
      stored.runtimeHosts,
      Object.values(participants)
    )
    const runtimeHosts = normalizedRuntimeHosts.runtimeHosts
    for (const participantId of normalizedRuntimeHosts.danglingParticipantIds)
      delete participants[participantId].runtimeHostId
    if (normalizedRuntimeHosts.changed) changed = true
    // #176 Phase B: provider claims/handles are separate from Phase-A
    // discovery projection. Loading deterministically expires claims and
    // drops bindings whose Human or Host no longer exists, never exposing
    // their private hash material to a Room projection.
    const normalizedRuntimeHostProviders = normalizeRuntimeHostProviders({
      providers: stored.runtimeHostProviders,
      pendingClaims: stored.runtimeHostProviderClaims,
      runtimeHosts,
      participants: Object.values(participants),
      now: Date.now(),
    })
    if (normalizedRuntimeHostProviders.changed) changed = true

    if (stored.nextMessageSequence !== nextMessageSequence) changed = true
    const attachments = Array.isArray(stored.attachments)
      ? stored.attachments.filter((attachment) =>
          this.validAttachment(attachment)
        )
      : []
    if (!Array.isArray(stored.attachments)) changed = true

    let pendingMediaCleanup: PendingMediaCleanup[]
    if (this.validPendingMediaCleanup(stored.pendingMediaCleanup)) {
      pendingMediaCleanup = stored.pendingMediaCleanup
    } else {
      pendingMediaCleanup = []
      changed = true
    }

    // #170 migration deliberately ignores every legacy singleton
    // voiceReply as authorization. Before dropping that state, however,
    // durable-stage its known outbound mid: an established Cloudflare track
    // keeps flowing after Room state has been rewritten unless the server
    // still owns the tracks/close handle. This is corrective revocation, not
    // a grant transfer — the Agent remains muted in agentVoice.
    const legacyVoiceParticipantId = this.legacyVoiceParticipantId(
      stored.voiceReply
    )
    if (stored.voiceReply !== undefined) changed = true
    if (legacyVoiceParticipantId) {
      const legacyParticipant = participants[legacyVoiceParticipantId]
      const legacyMid = legacyParticipant?.media?.agentPublishedMid
      if (legacyParticipant?.kind === "agent" && legacyMid) {
        pendingMediaCleanup = stageAgentMediaRevocation(
          legacyParticipant,
          pendingMediaCleanup,
          "published"
        )
        changed = true
      }
    }
    const normalizedGrants = normalizeMediaGrants({
      meetingNotes: stored.meetingNotes,
      agentVoice: stored.agentVoice,
      participants,
      runtimeHosts,
    })
    if (normalizedGrants.changed) changed = true
    const { meetingNotes, agentVoice } = normalizedGrants
    for (const participant of Object.values(participants)) {
      if (participant.kind !== "agent") continue
      const normalizedAgentMedia = normalizeAgentVoiceParticipantMedia(
        participant.media,
        agentVoice,
        participant.id
      )
      if (normalizedAgentMedia.changed) {
        participant.media = normalizedAgentMedia.media
        changed = true
      }
    }

    return {
      room: {
        createdAt: stored.createdAt,
        expiresAt: stored.expiresAt,
        participants,
        runtimeHosts,
        runtimeHostProviders: normalizedRuntimeHostProviders.providers,
        runtimeHostProviderClaims: normalizedRuntimeHostProviders.pendingClaims,
        messages,
        attachments,
        nextMessageSequence,
        meetingNotes,
        agentVoice,
        pendingMediaCleanup,
      },
      changed,
    }
  }

  private legacyVoiceParticipantId(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined
    const candidate = value as {
      agentParticipantId?: unknown
    }
    return typeof candidate.agentParticipantId === "string" &&
      candidate.agentParticipantId.length > 0
      ? candidate.agentParticipantId
      : undefined
  }

  private validPendingMediaCleanup(
    value: unknown
  ): value is PendingMediaCleanup[] {
    if (!Array.isArray(value)) return false
    return value.every((entry) => {
      if (!entry || typeof entry !== "object") return false
      const candidate = entry as Partial<PendingMediaCleanup>
      return (
        typeof candidate.sessionId === "string" &&
        candidate.sessionId.length > 0 &&
        Array.isArray(candidate.mids) &&
        candidate.mids.every((mid) => typeof mid === "string" && mid.length > 0)
      )
    })
  }

  private async saveRoom(room: RoomRecord): Promise<void> {
    await this.ctx.storage.put("room", room)
  }

  private validAttachment(value: unknown): value is RoomAttachment {
    if (!value || typeof value !== "object") return false
    const attachment = value as Partial<RoomAttachment>
    return (
      typeof attachment.id === "string" &&
      typeof attachment.senderId === "string" &&
      typeof attachment.senderName === "string" &&
      (attachment.mimeType === "image/jpeg" ||
        attachment.mimeType === "image/png" ||
        attachment.mimeType === "image/webp" ||
        attachment.mimeType === "text/plain" ||
        attachment.mimeType === "text/markdown" ||
        attachment.mimeType === "text/csv" ||
        attachment.mimeType === "application/json" ||
        attachment.mimeType === "text/yaml") &&
      typeof attachment.fileName === "string" &&
      typeof attachment.size === "number" &&
      Number.isSafeInteger(attachment.size) &&
      attachment.size > 0 &&
      attachment.size <= MAX_AGENT_ATTACHMENT_BYTES &&
      typeof attachment.chunkCount === "number" &&
      Number.isSafeInteger(attachment.chunkCount) &&
      attachment.chunkCount > 0 &&
      attachment.chunkCount <=
        Math.ceil(MAX_AGENT_ATTACHMENT_BYTES / ATTACHMENT_CHUNK_SIZE) &&
      typeof attachment.createdAt === "number" &&
      typeof attachment.sequence === "number"
    )
  }

  private attachmentChunkKey(id: string, index: number): string {
    return `attachment:${id}:${index}`
  }

  // #111: deletes every chunk of one snapshot. Best-effort by design —
  // orphan chunks are swept unconditionally at room expiry.
  private async deleteSurfaceChunks(
    participantId: string,
    surface: Pick<RoomSurfaceV1, "snapshotId" | "size">
  ): Promise<void> {
    const chunkCount = Math.ceil(surface.size / SURFACE_CHUNK_SIZE)
    const keys: string[] = []
    for (let index = 0; index < chunkCount; index += 1)
      keys.push(surfaceChunkKey(participantId, surface.snapshotId, index))
    await this.ctx.storage.delete(keys)
  }

  // #111: prefix sweep of ALL surface:* keys (including orphans from
  // interrupted publishes). Room expiry is the unconditional backstop.
  private async deleteAllSurfaceKeys(): Promise<void> {
    const entries = await this.ctx.storage.list({
      prefix: SURFACE_KEY_PREFIX,
    })
    if (entries.size > 0) await this.ctx.storage.delete([...entries.keys()])
  }

  private async deleteAttachmentChunks(
    attachment: Pick<RoomAttachment, "id" | "chunkCount">
  ): Promise<void> {
    for (let index = 0; index < attachment.chunkCount; index += 1)
      await this.ctx.storage.delete(
        this.attachmentChunkKey(attachment.id, index)
      )
  }

  private stateFor(room: RoomRecord): RoomState {
    return {
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      participants: Object.values(room.participants)
        .filter((participant) => participant.connected)
        .map(({ token: _token, connectionNonce: _nonce, ...participant }) => {
          // agentSubscribedMids is Cloudflare session bookkeeping used only
          // for server-side revocation (see realtimeMedia.ts) — never
          // participant-visible state.
          if (
            !participant.media?.agentSubscribedMids &&
            !participant.media?.agentPublishedMid &&
            !participant.media?.agentPublishedTrackName &&
            !participant.media?.agentVoiceReady
          )
            return participant
          const {
            agentSubscribedMids: _mids,
            agentPublishedMid: _publishedMid,
            agentPublishedTrackName: _publishedTrackName,
            agentVoiceReady: _voiceReady,
            ...media
          } = participant.media
          return { ...participant, media }
        }),
      // #176 Phase A: one readiness projection per Runtime Host id.
      runtimeHosts: projectRuntimeHosts(room.runtimeHosts),
      // #176 Phase B: only the Human ↔ Host association is browser-visible;
      // claim hashes and provider-handle hashes remain in RoomRecord only.
      runtimeHostProviders: projectRuntimeHostProviders(
        room.runtimeHostProviders
      ),
      messages: room.messages,
      meetingNotes: room.meetingNotes,
      meetingNotesMediaAvailable: this.env.AGENT_MEDIA_ENABLED === "true",
      agentVoice: room.agentVoice,
      agentVoiceMediaAvailable: this.env.AGENT_MEDIA_ENABLED === "true",
    }
  }

  private participantForInfo(participant: RoomParticipant) {
    const {
      token: _token,
      connectionNonce: _nonce,
      media: _media,
      ...safeParticipant
    } = participant
    return safeParticipant
  }

  private json(data: unknown, status = 200): Response {
    return Response.json(data, { status })
  }

  private isExpired(room: RoomRecord): boolean {
    return Date.now() >= room.expiresAt
  }

  // Recomputes room.expiresAt from current participant count. Must run after
  // every mutation that adds or removes a participant. See roomExpiry.ts.
  private applyEmptyRoomExpiry(room: RoomRecord, now: number): void {
    room.expiresAt = computeExpiresAt(
      Object.keys(room.participants).length,
      room.expiresAt,
      now
    )
  }

  private async activeRoom(): Promise<RoomRecord | null> {
    const room = await this.loadRoom()
    if (!room) return null
    if (this.isExpired(room)) {
      await this.expireRoom(room)
      return null
    }
    return room
  }

  // Steps 1-2 of the revocation sequence (round 4), direction-aware: thin
  // RoomRecord adapter over realtimeMedia.stageAgentMediaRevocation (pure +
  // unit-tested there). Synchronous staging only, no I/O; the caller
  // persists before attemptCleanupNow ever fetches. Meeting Notes triggers
  // stage "subscribed", voiceReply triggers stage "published", and whole-
  // participant teardown / full session rotation stages "both" so one
  // grant's stop can never revoke the other independent grant's media.
  private stageAgentMediaRevocation(
    room: RoomRecord,
    agentParticipantId: string,
    direction: AgentMediaRevocationDirection = "both"
  ): void {
    room.pendingMediaCleanup = stageAgentMediaRevocation(
      room.participants[agentParticipantId],
      room.pendingMediaCleanup,
      direction
    )
  }

  // The media-grant domain decides *which* participant/direction must be
  // revoked. RoomSession remains the sole owner of the established staging
  // bookkeeping and its persist-before-effect ordering.
  private stageMediaGrantRevocations(
    room: RoomRecord,
    revocations: AgentMediaRevocationIntent[]
  ): void {
    for (const { participantId, direction } of revocations)
      this.stageAgentMediaRevocation(room, participantId, direction)
  }

  // A readiness ACK is intentionally conservative: it means at least one
  // currently connected Human has a negotiated subscription. If any Human
  // connection leaves or drops, clear the private bits and require the next
  // subscriber to ACK again before the Runtime drains a future turn.
  private clearAgentVoiceReadiness(room: RoomRecord): void {
    for (const participant of Object.values(room.participants)) {
      if (participant.kind !== "agent" || !participant.media) continue
      delete participant.media.agentVoiceReady
    }
  }

  // The sole Room-side media-effect lifecycle. Every caller has already
  // staged the revocation and persisted that authoritative state before it
  // reaches here. This method then has exactly one temporal shape:
  //
  // persisted Room decision -> read-only exact effect snapshot -> Cloudflare
  // close -> fresh Room reload -> narrow confirmed-mid reconciliation.
  //
  // It never saves the pre-effect RoomRecord. That is what preserves any
  // participant, grant, session, or cleanup mutation interleaved while the
  // external request was in flight. Shared by every Agent revocation path
  // and by alarm() retries.
  private async attemptCleanupNow(
    entries: PendingMediaCleanup[]
  ): Promise<void> {
    const effects = snapshotMediaCloseEffects(entries)
    if (effects.length === 0) return
    const results = await executeMediaCloseEffects(this.env, effects)
    if (!results.some((result) => result.confirmedMids.length > 0)) return
    const fresh = await this.loadRoom()
    if (!fresh) return // room expired/deleted while these fetches were in flight
    fresh.pendingMediaCleanup = reconcileMediaCloseResults(
      fresh.pendingMediaCleanup,
      results
    )
    await this.saveRoom(fresh)
    await this.scheduleNextAlarm(fresh)
  }

  private async expireRoom(room: RoomRecord): Promise<void> {
    // A recycled room name must not inherit collaboration bookkeeping from
    // the expired generation (stale requestIds could suppress new ones).
    this.resetCollabTracking()
    // Best-effort, single attempt only — deliberately not retried through
    // the usual pendingMediaCleanup/alarm mechanism like the other
    // revocation sites: room expiry only fires for an *empty* room (see
    // applyEmptyRoomExpiry), so a still-active grant here means the granted
    // Agent's own departure (agent-leave/lease expiry, which already runs
    // the full stage+attempt+retry flow) is what emptied the room in the
    // first place — this is a defensive catch-all for an edge case that
    // should already be clear. Deliberately attempted *after* storage is
    // deleted below: there is no room left to persist a merge into either
    // way, so there's nothing to gain from ordering it before the delete,
    // and doing it after keeps the deletion itself uncontested by an
    // in-flight fetch.
    let pendingClose: PendingMediaCleanup[] = []
    if (room.meetingNotes.active && room.meetingNotes.agentParticipantId) {
      this.stageAgentMediaRevocation(room, room.meetingNotes.agentParticipantId)
      pendingClose = room.pendingMediaCleanup
    }
    // #111: unconditional prefix sweep — metadata dies with the room record,
    // chunk keys (including orphans from interrupted publishes) die here.
    await this.deleteAllSurfaceKeys()
    for (const attachment of room.attachments)
      await this.deleteAttachmentChunks(attachment)
    await this.ctx.storage.delete("room")
    await executeMediaCloseEffects(
      this.env,
      snapshotMediaCloseEffects(pendingClose)
    )
    for (const waiter of this.agentWaiters.values()) {
      if (!waiter) continue
      clearTimeout(waiter.timer)
      waiter.resolve(
        this.json({
          events: [],
          cursor: room.nextMessageSequence,
          expiresAt: room.expiresAt,
          expired: true,
        })
      )
    }
    this.agentWaiters.clear()
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "expired" }))
        socket.close(4001, "Room expired")
      } catch {
        // A socket may already be closed while the room is expiring.
      }
    }
  }

  private async broadcast(message: unknown, except?: WebSocket): Promise<void> {
    const encoded = JSON.stringify(message)
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue
      try {
        socket.send(encoded)
      } catch {
        socket.close(1011, "Broadcast failed")
      }
    }
  }

  private async broadcastState(
    room?: RoomRecord,
    except?: WebSocket
  ): Promise<void> {
    const current = room ?? (await this.activeRoom())
    if (current) {
      await this.broadcast(
        { type: "state", state: this.stateFor(current) },
        except
      )
    }
  }

  private async scheduleNextAlarm(room: RoomRecord): Promise<void> {
    const deadlines = [room.expiresAt]
    for (const participant of Object.values(room.participants)) {
      if (participant.kind === "agent") {
        deadlines.push(participant.lastSeenAt + AGENT_LEASE_MS)
      } else if (!participant.connected) {
        deadlines.push(participant.lastSeenAt + RECONNECT_GRACE_MS)
      }
    }
    // A pending media cleanup (Blocker 1) needs a much sooner wakeup than
    // the lease/reconnect/expiry deadlines above would otherwise provide —
    // otherwise a failed Cloudflare close could sit unretried for however
    // long the room happens to stay quiet.
    if (room.pendingMediaCleanup.length > 0)
      deadlines.push(Date.now() + MEDIA_CLEANUP_RETRY_MS)
    for (const claim of Object.values(room.runtimeHostProviderClaims ?? {}))
      deadlines.push(claim.expiresAt)
    await this.ctx.storage.setAlarm(Math.min(...deadlines))
  }

  // Runtime Host projection garbage collection and provider-association
  // garbage collection are coupled deliberately: a provider capability for a
  // Host that no longer exists must never survive to authorize a future host.
  private garbageCollectRuntimeHostAuthorization(room: RoomRecord): void {
    room.runtimeHosts = garbageCollectRuntimeHosts(
      room.runtimeHosts,
      Object.values(room.participants)
    )
    room.runtimeHostProviders = garbageCollectRuntimeHostProviders({
      providers: room.runtimeHostProviders ?? {},
      runtimeHosts: room.runtimeHosts,
    })
  }

  // A true Human departure (explicit leave or expiry) revokes its Room-only
  // provider associations and unredeemed claims. A WebSocket reconnect keeps
  // the participant record, therefore intentionally does not call this.
  private removeRuntimeHostProviderAuthorizationForHuman(
    room: RoomRecord,
    humanParticipantId: string
  ): void {
    const next = removeRuntimeHostProviderForHuman({
      providers: room.runtimeHostProviders ?? {},
      pendingClaims: room.runtimeHostProviderClaims ?? {},
      humanParticipantId,
    })
    room.runtimeHostProviders = next.providers
    room.runtimeHostProviderClaims = next.pendingClaims
  }

  private findParticipant(
    room: RoomRecord,
    participantId: string,
    token: string,
    sessionId?: string
  ): RoomParticipant | null {
    const participant = room.participants[participantId]
    if (!participant || participant.token !== token) return null
    if (sessionId && participant.media?.sessionId !== sessionId) return null
    return participant
  }

  private appendMessage(
    room: RoomRecord,
    message: Omit<RoomMessage, "sequence">
  ): RoomMessage {
    const roomMessage = {
      ...message,
      sequence: room.nextMessageSequence + 1,
    }
    room.nextMessageSequence = roomMessage.sequence
    room.messages = [...room.messages, roomMessage].slice(-MAX_MESSAGES)
    return roomMessage
  }

  private toAgentEvent(
    message: RoomMessage,
    participantId: string
  ): AgentEvent {
    return {
      sequence: message.sequence,
      type: message.type,
      participant: {
        id: message.peerId,
        name: message.name,
        kind: message.kind,
      },
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.actionType === undefined
        ? {}
        : { actionType: message.actionType }),
      ...(message.actionPayload === undefined
        ? {}
        : { actionPayload: message.actionPayload }),
      ...(message.collab === undefined ? {} : { collab: message.collab }),
      addressed: message.targets?.includes(participantId) === true,
      createdAt: message.createdAt,
    }
  }

  private toAttachmentEvent(
    attachment: RoomAttachment,
    senderKind: ParticipantKind
  ): AgentEvent {
    return {
      sequence: attachment.sequence,
      type: "image",
      participant: {
        id: attachment.senderId,
        name: attachment.senderName,
        kind: senderKind,
      },
      attachment: {
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
      },
      addressed: false,
      createdAt: attachment.createdAt,
    }
  }

  private agentEvents(
    room: RoomRecord,
    participantId: string,
    cursor: number
  ): {
    events: AgentEvent[]
    cursor: number
    expiresAt: number
    truncated?: boolean
  } {
    const serverCursor = room.nextMessageSequence
    const clampedCursor = Math.min(Math.max(cursor, 0), serverCursor)
    const events = [
      ...room.messages.map((message) => ({
        sequence: message.sequence,
        event: this.toAgentEvent(message, participantId),
        peerId: message.peerId,
      })),
      ...room.attachments.map((attachment) => ({
        sequence: attachment.sequence,
        event: this.toAttachmentEvent(
          attachment,
          room.participants[attachment.senderId]?.kind ?? "human"
        ),
        peerId: attachment.senderId,
      })),
    ].sort((left, right) => left.sequence - right.sequence)
    const firstSequence = events[0]?.sequence
    const truncated =
      firstSequence !== undefined && clampedCursor < firstSequence - 1
    const effectiveCursor = truncated ? firstSequence - 1 : clampedCursor
    return {
      events: events
        .filter(
          (entry) =>
            entry.sequence > effectiveCursor && entry.peerId !== participantId
        )
        .map((entry) => entry.event),
      cursor: serverCursor,
      expiresAt: room.expiresAt,
      ...(truncated ? { truncated: true } : {}),
    }
  }

  private finishWaiter(waiter: AgentWaiter, response: Response): void {
    clearTimeout(waiter.timer)
    if (this.agentWaiters.get(waiter.participantId) === waiter)
      this.agentWaiters.delete(waiter.participantId)
    waiter.resolve(response)
  }

  private resolveAgentWaiters(room: RoomRecord): void {
    for (const waiter of this.agentWaiters.values()) {
      if (!waiter) continue
      const result = this.agentEvents(room, waiter.participantId, waiter.cursor)
      if (
        result.events.length > 0 ||
        result.cursor > waiter.cursor ||
        result.truncated
      ) {
        this.finishWaiter(
          waiter,
          this.json({
            ...result,
            participants: rosterProjection(room.participants),
            runtimeHosts: projectRuntimeHosts(room.runtimeHosts),
          })
        )
      }
    }
  }

  private async waitForAgent(
    request: Extract<ControlRequest, { action: "agent-wait" }>
  ): Promise<Response> {
    const room = await this.activeRoom()
    if (!room) return this.json({ error: "room_expired" }, 410)
    const participant = this.findParticipant(
      room,
      request.participantId,
      request.token
    )
    if (!participant) return this.json({ error: "unauthorized" }, 401)
    if (participant.kind !== "agent")
      return this.json({ error: "agent_only" }, 403)
    if (this.agentWaiters.has(participant.id))
      return this.json({ error: "wait_already_pending" }, 409)

    this.agentWaiters.set(participant.id, null)

    try {
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)

      const result = this.agentEvents(room, participant.id, request.cursor)
      const cursorWasAhead = request.cursor > room.nextMessageSequence
      if (
        cursorWasAhead ||
        result.events.length > 0 ||
        result.cursor > request.cursor ||
        result.truncated ||
        request.timeoutSeconds === 0
      ) {
        this.agentWaiters.delete(participant.id)
        return this.json({
          ...result,
          // Compact participant/capability projection (#106 Phase A): lets a
          // resident Harness answer "who here can potentially do X" without
          // dumping the full room state into every turn.
          participants: rosterProjection(room.participants),
          // #176 Phase A: one readiness projection per Runtime Host id.
          runtimeHosts: projectRuntimeHosts(room.runtimeHosts),
        })
      }

      return new Promise<Response>((resolve) => {
        const waiter: AgentWaiter = {
          participantId: participant.id,
          cursor: request.cursor,
          resolve,
          timer: setTimeout(() => {
            if (this.agentWaiters.get(participant.id) !== waiter) return
            this.agentWaiters.delete(participant.id)
            void this.activeRoom().then((current) => {
              if (!current) {
                resolve(
                  this.json({
                    events: [],
                    cursor: room.nextMessageSequence,
                    expiresAt: room.expiresAt,
                    expired: true,
                  })
                )
                return
              }
              resolve(
                this.json({
                  ...this.agentEvents(current, participant.id, request.cursor),
                  participants: rosterProjection(current.participants),
                  runtimeHosts: projectRuntimeHosts(current.runtimeHosts),
                })
              )
            })
          }, request.timeoutSeconds * 1000),
        }
        this.agentWaiters.set(participant.id, waiter)
      })
    } catch (error) {
      this.agentWaiters.delete(participant.id)
      throw error
    }
  }

  private async handleControl(request: ControlRequest): Promise<Response> {
    if (request.action === "room-info") {
      const room = await this.activeRoom()
      return this.json({
        exists: room !== null,
        expiresAt: room?.expiresAt ?? null,
        participants: room
          ? Object.values(room.participants)
              .filter((participant) => participant.connected)
              .map((participant) => this.participantForInfo(participant))
          : [],
        // #176 Phase A: one readiness projection per Runtime Host id.
        runtimeHosts: projectRuntimeHosts(room?.runtimeHosts),
        // #176 Phase B intentionally projects only the Room-visible
        // Human-to-Host association. Claim hashes and provider-handle hashes
        // never leave durable Room state.
        runtimeHostProviders: projectRuntimeHostProviders(
          room?.runtimeHostProviders
        ),
        capabilities: ROOM_CAPABILITIES,
        // Room-visible state, not a capability secret — the same
        // agentParticipantId is already visible in `participants` above.
        meetingNotes: room?.meetingNotes ?? NO_MEETING_NOTES,
        meetingNotesMediaAvailable: this.env.AGENT_MEDIA_ENABLED === "true",
        agentVoice: room?.agentVoice ?? {},
        agentVoiceMediaAvailable: this.env.AGENT_MEDIA_ENABLED === "true",
        mediaPermissions: room
          ? agentMediaPermissions(
              room.meetingNotes,
              room.agentVoice,
              request.participantId
            )
          : { canSubscribeHumanAudio: false, canPublishVoice: false },
      })
    }

    if (request.action === "agent-wait") return this.waitForAgent(request)

    if (request.action === "register" || request.action === "agent-register") {
      const now = Date.now()
      const isAgent = request.action === "agent-register"
      // Complete local validation and the WebCrypto digest before loading
      // RoomRecord. The subsequent load → consume → save section has no
      // external await, so a claim can be redeemed atomically without ever
      // retaining a stale RoomRecord across asynchronous crypto work.
      let registeredRuntimeHost: RuntimeHostProjection | undefined
      if (isAgent && request.participant.runtimeHost !== undefined) {
        const validatedHost = validateRuntimeHost(
          request.participant.runtimeHost
        )
        if (validatedHost.ok && validatedHost.runtimeHost)
          registeredRuntimeHost = validatedHost.runtimeHost
      }
      const providerClaimHash = isAgent
        ? request.participant.providerClaimHash
        : undefined
      const runtimeProviderHandle = isAgent
        ? request.participant.runtimeProviderHandle
        : undefined
      if (
        providerClaimHash !== undefined &&
        !isRuntimeProviderClaimHash(providerClaimHash)
      )
        return this.json({ error: "invalid_runtime_provider_claim" }, 400)
      if (
        runtimeProviderHandle !== undefined &&
        !isRuntimeProviderClaimHash(runtimeProviderHandle)
      )
        return this.json({ error: "runtime_provider_handle_invalid" }, 400)
      if (providerClaimHash && runtimeProviderHandle)
        return this.json({ error: "invalid_runtime_provider_claim" }, 400)
      if (
        (providerClaimHash || runtimeProviderHandle) &&
        !registeredRuntimeHost
      )
        return this.json({ error: "runtime_provider_host_required" }, 400)

      let providerHandleForResponse: string | undefined
      let providerHandleHash: string | undefined
      if (providerClaimHash && registeredRuntimeHost) {
        providerHandleForResponse = createRuntimeProviderHandle()
        providerHandleHash = await hashRuntimeProviderHandle(
          this.ctx.id.toString(),
          registeredRuntimeHost.runtimeHostId,
          providerHandleForResponse
        )
      } else if (runtimeProviderHandle && registeredRuntimeHost) {
        providerHandleHash = await hashRuntimeProviderHandle(
          this.ctx.id.toString(),
          registeredRuntimeHost.runtimeHostId,
          runtimeProviderHandle
        )
      }
      let room = await this.loadRoom()
      if (room && this.isExpired(room)) {
        await this.expireRoom(room)
        return this.json({ error: "room_expired" }, 410)
      }
      if (!room) {
        this.resetCollabTracking()
        room = {
          createdAt: now,
          expiresAt: NO_EXPIRY,
          participants: {},
          messages: [],
          attachments: [],
          nextMessageSequence: 0,
          meetingNotes: NO_MEETING_NOTES,
          agentVoice: {},
          pendingMediaCleanup: [],
          runtimeHostProviders: {},
          runtimeHostProviderClaims: {},
        }
      }
      if (room.participants[request.participant.id])
        return this.json({ error: "participant_exists" }, 409)
      if (
        (isAgent && request.participant.kind !== "agent") ||
        (!isAgent &&
          (request.participant.kind !== "human" || !request.participant.media))
      ) {
        return this.json({ error: "invalid_participant_kind" }, 400)
      }
      // #106 Phase A: a joining agent may advertise an explicit bounded
      // capability list chosen by its Runtime/Harness. Invalid input rejects
      // the join — never repaired silently (see do/collab.ts).
      let registeredCapabilities: AgentCapabilities = { text: true }
      if (isAgent) {
        const validated = validateAdvertisedCapabilities(
          request.participant.capabilities?.advertised ?? []
        )
        if (validated.ok === false)
          return this.json(
            { error: validated.error, reason: validated.reason },
            400
          )
        registeredCapabilities = agentCapabilitiesFrom(validated.capabilities)
      }
      // The raw projection object never persists — only the canonical
      // runtimeHostId on the participant and the map entry below.
      const participantWire = {
        ...request.participant,
      } as Omit<RoomParticipant, "connected" | "lastSeenAt" | "runtimeHostId">
      // Private Phase-B wire fields never become participant state. Use
      // explicit deletes instead of destructuring because this branch also
      // accepts the Human registration wire shape.
      delete (participantWire as Record<string, unknown>).runtimeHost
      delete (participantWire as Record<string, unknown>).providerClaimHash
      delete (participantWire as Record<string, unknown>).runtimeProviderHandle
      const participant: RoomParticipant = {
        ...participantWire,
        connected: isAgent,
        lastSeenAt: now,
        ...(isAgent
          ? {
              capabilities: registeredCapabilities,
              media: undefined,
              ...(registeredRuntimeHost
                ? { runtimeHostId: registeredRuntimeHost.runtimeHostId }
                : {}),
            }
          : {}),
      }
      if (registeredRuntimeHost && providerClaimHash && providerHandleHash) {
        const redemption = redeemRuntimeHostProviderClaim({
          providers: room.runtimeHostProviders ?? {},
          pendingClaims: room.runtimeHostProviderClaims ?? {},
          participants: Object.values(room.participants),
          runtimeHost: registeredRuntimeHost,
          claimHash: providerClaimHash,
          providerHandleHash,
          now,
        })
        if (redemption.ok === false)
          return this.json({ error: redemption.error }, 403)
        room.runtimeHostProviders = redemption.providers
        room.runtimeHostProviderClaims = redemption.pendingClaims
      } else if (registeredRuntimeHost) {
        const proof = verifyRuntimeHostProviderProof({
          providers: room.runtimeHostProviders ?? {},
          runtimeHostId: registeredRuntimeHost.runtimeHostId,
          providerHandleHash,
        })
        if (proof.ok === false) return this.json({ error: proof.error }, 403)
      }

      room.participants[participant.id] = participant
      if (registeredRuntimeHost)
        // Canonical Room model (#176): ONE readiness projection per host id,
        // shared by all same-host Agents.
        room.runtimeHosts = registerRuntimeHost(
          room.runtimeHosts,
          registeredRuntimeHost
        )
      this.applyEmptyRoomExpiry(room, now)
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      if (isAgent) {
        await this.broadcastState(room)
        return this.json({
          participant: this.participantForInfo(participant),
          cursor: room.nextMessageSequence,
          expiresAt: room.expiresAt,
          ...(providerHandleForResponse
            ? { runtimeProviderHandle: providerHandleForResponse }
            : {}),
        })
      }
      return this.json({
        state: this.stateFor(room),
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-create-room") {
      // Create-only gate (#51): ANY pre-existing room state under this id —
      // active or expired-but-unswept — fails this attempt closed. Expired
      // state is expired first (frees the storage key for a bounded retry
      // with a fresh id) but never joined and never mutated by the caller.
      const existing = await this.loadRoom()
      if (existing) {
        if (this.isExpired(existing)) await this.expireRoom(existing)
        return this.json({ error: "room_already_exists" }, 409)
      }
      if (request.participant.kind !== "agent")
        return this.json({ error: "invalid_participant_kind" }, 400)
      const validated = validateAdvertisedCapabilities(
        request.participant.capabilities?.advertised ?? []
      )
      if (validated.ok === false)
        return this.json(
          { error: validated.error, reason: validated.reason },
          400
        )
      const now = Date.now()
      // The creator is merely participant #1 of an ordinary room: no owner,
      // admin, or orchestrator role exists anywhere in the model.
      const room: RoomRecord = {
        createdAt: now,
        expiresAt: NO_EXPIRY,
        participants: {},
        messages: [],
        attachments: [],
        nextMessageSequence: 0,
        meetingNotes: NO_MEETING_NOTES,
        agentVoice: {},
        pendingMediaCleanup: [],
        runtimeHostProviders: {},
        runtimeHostProviderClaims: {},
      }
      const participant: RoomParticipant = {
        ...request.participant,
        connected: true,
        lastSeenAt: now,
        capabilities: agentCapabilitiesFrom(validated.capabilities),
        media: undefined,
      }
      room.participants[participant.id] = participant
      this.applyEmptyRoomExpiry(room, now)
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.broadcastState(room)
      return this.json({
        participant: this.participantForInfo(participant),
        cursor: room.nextMessageSequence,
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-send-text") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      const text = request.text.trim()
      if (!text) return this.json({ error: "text_required" }, 400)
      participant.lastSeenAt = Date.now()
      const roomMessage = this.appendMessage(room, {
        id: crypto.randomUUID(),
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        type: "text",
        text: text.slice(0, 4000),
        // #165: Agent-originated explicit addressing reuses the exact Room
        // target semantics of the Human chat path (dedupe, current-Agent
        // filter, MAX_TARGETS). Self-targets are dropped so an Agent can
        // never wake itself into a loop; malformed entries can only ever
        // degrade to an ordinary unaddressed message.
        ...agentTextTargets(request.targetParticipantIds, participant.id, room),
        createdAt: Date.now(),
      })
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.broadcast({ type: "message", message: roomMessage })
      this.resolveAgentWaiters(room)
      return this.json({
        sequence: roomMessage.sequence,
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-update-capabilities") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      const validated = validateAdvertisedCapabilities(request.capabilities)
      if (validated.ok === false)
        return this.json(
          { error: validated.error, reason: validated.reason },
          400
        )
      participant.capabilities = agentCapabilitiesFrom(validated.capabilities)
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.broadcastState(room)
      return this.json({
        capabilities: participant.capabilities,
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-update-runtime-host") {
      // Validate and hash private proof before reading RoomRecord. Once we
      // load it, proof verification and projection update are a storage-only
      // transaction with no external await/stale-record window.
      const validated = validateRuntimeHost(request.runtimeHost)
      if (!validated.ok)
        return this.json(
          { error: validated.error, reason: validated.reason },
          400
        )
      const host = validated.runtimeHost
      let providerHandleHash: string | undefined
      if (request.runtimeProviderHandle !== undefined) {
        if (!isRuntimeProviderClaimHash(request.runtimeProviderHandle))
          return this.json({ error: "runtime_provider_handle_invalid" }, 400)
        providerHandleHash = await hashRuntimeProviderHandle(
          this.ctx.id.toString(),
          host.runtimeHostId,
          request.runtimeProviderHandle
        )
      }
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      // Discovery remains available for unbound Hosts. A Host that a Human
      // explicitly bound can only update its readiness while proving the
      // private handle for this exact Host id.
      const providerProof = verifyRuntimeHostProviderProof({
        providers: room.runtimeHostProviders ?? {},
        runtimeHostId: host.runtimeHostId,
        providerHandleHash,
      })
      if (providerProof.ok === false)
        return this.json({ error: providerProof.error }, 403)
      // Canonical Room model (#176): upsert ONE readiness projection per host
      // id, shared by all same-host Agents. Agent Voice consumes the
      // resulting Runtime Host transition as an explicit pure grant decision.
      const runtimeHostTransition = updateRuntimeHost(
        room.runtimeHosts,
        Object.values(room.participants),
        participant.id,
        host
      )
      room.runtimeHosts = runtimeHostTransition.runtimeHosts
      participant.runtimeHostId = host.runtimeHostId
      const voiceTransition = transitionAgentVoiceForRuntimeHostUpdate({
        agentVoice: room.agentVoice,
        participants: Object.values(room.participants),
        participant,
        currentHost: host,
        previousHostId: runtimeHostTransition.previousHostId,
        previousProjection: runtimeHostTransition.previousProjection,
      })
      room.agentVoice = voiceTransition.agentVoice
      this.stageMediaGrantRevocations(room, voiceTransition.revocations)
      // Re-projection may move this participant to a new host id: collect
      // the previously referenced host if nothing else uses it.
      this.garbageCollectRuntimeHostAuthorization(room)
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.broadcastState(room)
      await this.attemptCleanupNow(room.pendingMediaCleanup)
      return this.json({
        runtimeHost: host,
        runtimeHosts: projectRuntimeHosts(room.runtimeHosts),
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-clear-surface") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      // Own-surface-only clear. No history: chunks die with the metadata
      // swap, and no message/sequence/waiter interaction occurs.
      const previous = participant.surface
      delete participant.surface
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      // Clear succeeds even if chunk deletion hiccups (best-effort, #111).
      await deleteSurfaceChunksBestEffort(() =>
        previous
          ? this.deleteSurfaceChunks(participant.id, previous)
          : Promise.resolve()
      )
      await this.broadcastState(room)
      return this.json({
        ok: true,
        cleared: Boolean(previous),
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-read-surface") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      // Any authenticated current participant may read; the snapshotId match
      // closes the TOCTOU window — a replaced/cleared surface can never
      // serve stale bytes.
      const reader = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!reader) return this.json({ error: "unauthorized" }, 401)
      const source = room.participants[request.sourceParticipantId]
      if (
        !source ||
        source.kind !== "agent" ||
        !source.surface ||
        source.surface.snapshotId !== request.snapshotId
      ) {
        const exists = source?.kind === "agent" && Boolean(source.surface)
        return this.json(
          { error: exists ? "surface_changed" : "surface_not_found" },
          exists ? 410 : 404
        )
      }
      const surface = source.surface
      const chunkCount = Math.ceil(surface.size / SURFACE_CHUNK_SIZE)
      const chunks: Uint8Array[] = []
      for (let index = 0; index < chunkCount; index += 1) {
        const chunk = await this.ctx.storage.get<ArrayBuffer>(
          surfaceChunkKey(source.id, surface.snapshotId, index)
        )
        if (!chunk) return this.json({ error: "surface_not_found" }, 404)
        chunks.push(new Uint8Array(chunk))
      }
      let binary = ""
      for (const chunk of chunks)
        for (const byte of chunk) binary += String.fromCharCode(byte)
      reader.lastSeenAt = Date.now()
      await this.saveRoom(room)
      // Observation bytes must never be cached anywhere downstream.
      return new Response(
        JSON.stringify({
          surface,
          data: btoa(binary),
          expiresAt: room.expiresAt,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }
      )
    }

    if (request.action === "agent-send-collab") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      participant.lastSeenAt = Date.now()
      const eventInput = request.event ?? {}
      const eventKind = (eventInput as { kind?: unknown }).kind

      // #113: REQUESTS share one ingestion path with Human-originated
      // requests (validate → registry dedup → append → broadcast → waiters).
      if (eventKind === "request") {
        const ingest = await this.ingestCollabWorkRequest(
          room,
          participant,
          eventInput as {
            requestId?: unknown
            targetParticipantId?: unknown
            summary?: unknown
            details?: unknown
            attachmentIds?: unknown
          }
        )
        if (ingest.status === "rejected")
          return this.json({ error: ingest.error }, 400)
        return this.json({
          requestId: ingest.event.requestId,
          sequence: ingest.sequence,
          ...(ingest.status === "duplicate" ? { duplicate: true } : {}),
          expiresAt: room.expiresAt,
        })
      }

      // #113/#115: RESPONSES share one ingestion path with Human
      // accepted/declined (warm → validate → precheck-dedup → routing →
      // append → commit → persist → broadcast → waiters).
      const ingest = await this.ingestCollabResponse(
        room,
        participant,
        eventInput as {
          requestId?: unknown
          kind?: unknown
          summary?: unknown
          details?: unknown
          attachmentIds?: unknown
        }
      )
      if (ingest.status === "rejected")
        return this.json(
          { error: ingest.error },
          ingest.error === "unknown_request" ||
            ingest.error === "not_request_target"
            ? 403
            : 400
        )
      return this.json({
        requestId: ingest.event.requestId,
        sequence: ingest.sequence,
        ...(ingest.status === "duplicate" ? { duplicate: true } : {}),
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-media-admit") {
      // #83 review: admission probe for the ONE shared Agent SFU session.
      // Authorizes on meetingNotes OR voiceReply naming THIS connected
      // agent; deliberately returns no room/media state — Human media
      // discovery stays agent-room-media-only (Meeting Notes grant).
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      if (
        !isAgentAuthorizedForSharedMedia(
          room.meetingNotes,
          room.agentVoice,
          participant.id
        )
      )
        return this.json({ error: "agent_media_not_authorized" }, 403)
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      return this.json({ ok: true, expiresAt: room.expiresAt })
    }

    if (request.action === "agent-media-attach") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      // Round 5 (P1): the Worker's authorize() check before creating this
      // Cloudflare session (agent-room-media, in the "agent-session"
      // route) is not enough on its own — that /sessions/new call is
      // external I/O, during which the Human could Stop or reassign
      // Meeting Notes. Re-check the CURRENT grant here and refuse to
      // attach — never mutate the participant into a new active media
      // session — if it's no longer valid. #83 review: the shared session
      // is admissible under EITHER independent grant (meetingNotes OR
      // voiceReply) naming this agent; this check admits transport only.
      if (
        !isAgentAuthorizedForSharedMedia(
          room.meetingNotes,
          room.agentVoice,
          participant.id
        )
      )
        return this.json({ error: "meeting_notes_not_authorized" }, 403)
      if (participant.media?.sessionId === request.sessionId) {
        // Idempotent: the same session re-attaching (e.g. a retried
        // request) must not disturb already-tracked subscriptions.
        participant.lastSeenAt = Date.now()
        await this.saveRoom(room)
        await this.scheduleNextAlarm(room)
        return this.json({ ok: true, expiresAt: room.expiresAt })
      }
      // Rotating an existing session (S1 -> S2): Cloudflare does not close
      // S1 merely because RoomSession now points at S2, so S1's
      // already-tracked subscriptions must not be silently forgotten —
      // reuse the exact same stage/persist/fetch/fresh-reload/narrow-merge
      // pattern as every other revocation path (round 4). A no-op when
      // there is no existing session yet (a brand-new agent's first
      // attach) since stageAgentMediaRevocation itself no-ops without
      // existing media.
      this.stageAgentMediaRevocation(room, participant.id)
      // Subscribe-only: an agent never publishes in the current protocol,
      // so its media state never carries tracks of its own.
      participant.media = {
        sessionId: request.sessionId,
        muted: true,
        fileChannelReady: false,
        tracks: [],
      }
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.attemptCleanupNow(room.pendingMediaCleanup)
      return this.json({ ok: true, expiresAt: room.expiresAt })
    }

    if (request.action === "agent-room-media") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      // The real authorization boundary: this agent must be the one
      // Human-selected note-taker for an *active* Meeting Notes grant on
      // this room. Holding a valid agent participant token is necessary
      // but never sufficient — an ordinary text-only agent that joined
      // the room but was never granted the Meeting Notes role is rejected
      // here even though its token is perfectly valid. AGENT_MEDIA_ENABLED
      // (sfu/server.ts) is an additional, coarser master switch on top of
      // this — off, it blocks everyone regardless of any room grant; on,
      // it still requires this per-room, per-agent grant to actually see
      // Human media. Setting it alone was never meant to be sufficient.
      if (!isAgentAuthorizedForMedia(room.meetingNotes, participant.id))
        return this.json({ error: "meeting_notes_not_authorized" }, 403)
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      // Deliberately narrower than participantForInfo/room-info: this is
      // not exposed through the MCP tool surface. Only Human media is
      // exposed — Phase 0 MediaBridge only ever ingests Human audio.
      const participants = Object.values(room.participants)
        .filter(
          (
            candidate
          ): candidate is RoomParticipant & {
            media: NonNullable<RoomParticipant["media"]>
          } =>
            candidate.kind === "human" &&
            candidate.connected &&
            Boolean(candidate.media)
        )
        .map((candidate) => ({
          participantId: candidate.id,
          name: candidate.name,
          sessionId: candidate.media.sessionId,
          tracks: candidate.media.tracks,
        }))
      return this.json({ participants, expiresAt: room.expiresAt })
    }

    if (request.action === "agent-track-subscribed") {
      // Records the Cloudflare-assigned mid(s) for the granted Agent's
      // remote (subscribe) track negotiations, so an active Meeting Notes
      // revocation can actually close them server-side (see
      // stageAgentMediaRevocation/realtimeMedia.ts) instead of only
      // preventing *future* subscriptions.
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      if (!isAgentAuthorizedForMedia(room.meetingNotes, participant.id))
        return this.json({ error: "meeting_notes_not_authorized" }, 403)
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      const mids = request.mids.filter(
        (mid) => typeof mid === "string" && mid.length > 0
      )
      const merged = new Set([
        ...(participant.media.agentSubscribedMids ?? []),
        ...mids,
      ])
      // Fail closed rather than silently truncating (round 4): an agent's
      // actively subscribed mids must never be dropped from tracking — a
      // dropped mid could never be closed later on revocation. Also refuse
      // while the room's pending-cleanup queue is already at capacity
      // (below), since admitting more trackable media while existing
      // revoked media hasn't confirmed closed only compounds the backlog.
      if (merged.size > MAX_AGENT_SUBSCRIBED_MIDS)
        return this.json({ error: "agent_media_capacity_exceeded" }, 503)
      if (
        !pendingCleanupHasCapacity(
          room.pendingMediaCleanup,
          participant.media.sessionId
        )
      )
        return this.json({ error: "agent_media_cleanup_backlog" }, 503)
      participant.media.agentSubscribedMids = [...merged]
      await this.saveRoom(room)
      return this.json({ ok: true })
    }

    if (request.action === "agent-media-cleanup-pending") {
      // Blocker 2 hand-off: the Worker's /api/sfu/tracks route already
      // tried to close a just-created-but-now-unauthorized Agent
      // subscription itself (the grant was revoked/reassigned between
      // authorize() and the upstream tracks/new call completing); if that
      // close attempt didn't confirm success, this queues it for retry.
      // Deliberately does not require the Agent participant to still
      // exist — it may already have left or expired by the time this
      // arrives, and sessionId/mids are self-contained enough to retry
      // closing without it. Unlike admitting a *new* subscription
      // (agent-track-subscribed above), this is corrective hand-off for
      // media Cloudflare has already created — it is never refused for
      // capacity, only queued, matching queuePendingCleanup's own
      // never-evict contract.
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const mids = request.mids.filter(
        (mid) => typeof mid === "string" && mid.length > 0
      )
      if (mids.length === 0 || !request.sessionId)
        return this.json({ error: "invalid_track" }, 400)
      room.pendingMediaCleanup = queuePendingCleanup(
        room.pendingMediaCleanup,
        request.sessionId,
        mids
      )
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      return this.json({ ok: true })
    }

    if (request.action === "agent-read-attachment") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      // #117: reconstruction shared with the Human browser read path;
      // authorization stays here at the ingress boundary.
      const payload = await this.readAttachmentPayload(
        room,
        request.attachmentId
      )
      if ("error" in payload) return this.json({ error: payload.error }, 404)
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      return this.json({
        attachment: {
          id: payload.attachment.id,
          fileName: payload.attachment.fileName,
          mimeType: payload.attachment.mimeType,
          size: payload.attachment.size,
        },
        data: payload.data,
        expiresAt: room.expiresAt,
      })
    }

    // #117: authenticated CURRENT HUMAN reads an existing room attachment
    // through the browser (#111 surfaces/read precedent). Observation only:
    // never touches messages, sequence numbers, waiters, or collab state.
    // Membership is the authorization — attachments are Room-scoped
    // collaboration artifacts, not per-file ACL'd blobs — and attachmentId
    // alone grants nothing.
    if (request.action === "human-read-attachment") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "human")
        return this.json({ error: "human_only" }, 403)
      // Current room.attachments metadata gates the read (TOCTOU rule):
      // evicted/unknown ids fail closed even if detached chunks linger.
      const payload = await this.readAttachmentPayload(
        room,
        request.attachmentId
      )
      if ("error" in payload) return this.json({ error: payload.error }, 404)
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      return new Response(
        JSON.stringify({
          attachment: {
            id: payload.attachment.id,
            fileName: payload.attachment.fileName,
            mimeType: payload.attachment.mimeType,
            size: payload.attachment.size,
          },
          data: payload.data,
          expiresAt: room.expiresAt,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            // Observation bytes must never be cached downstream.
            "Cache-Control": "no-store",
          },
        }
      )
    }

    if (request.action === "agent-leave") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "already_left" }, 404)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      // Revocation must be durable *before* any Cloudflare fetch is
      // attempted (round 4) — stage the mutation, persist it, then only
      // afterward attempt the actual close against a fresh reload. See
      // stageAgentMediaRevocation/attemptCleanupNow's own comments.
      const grantTransition = transitionMediaGrantsForParticipantDeparture({
        meetingNotes: room.meetingNotes,
        agentVoice: room.agentVoice,
        participant,
      })
      this.stageMediaGrantRevocations(room, grantTransition.revocations)
      const departingSurface = participant.surface
      delete room.participants[participant.id]
      this.garbageCollectRuntimeHostAuthorization(room)
      room.meetingNotes = grantTransition.meetingNotes
      room.agentVoice = grantTransition.agentVoice
      this.applyEmptyRoomExpiry(room, Date.now())
      await this.saveRoom(room)
      // #111: no surface history survives departure — chunks die after the
      // metadata removal is durable, best-effort so departure always
      // continues to broadcast/scheduling/Meeting-Notes media cleanup.
      if (departingSurface)
        await deleteSurfaceChunksBestEffort(() =>
          this.deleteSurfaceChunks(participant.id, departingSurface)
        )
      const waiter = this.agentWaiters.get(participant.id)
      if (waiter) {
        this.finishWaiter(
          waiter,
          this.json({
            events: [],
            cursor: room.nextMessageSequence,
            expiresAt: room.expiresAt,
            left: true,
          })
        )
      } else {
        this.agentWaiters.delete(participant.id)
      }
      await this.broadcastState(room)
      await this.scheduleNextAlarm(room)
      await this.attemptCleanupNow(room.pendingMediaCleanup)
      return this.json({ ok: true })
    }

    const room = await this.activeRoom()
    if (!room) return this.json({ error: "room_expired" }, 410)

    if (request.action === "authorize") {
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      // Finding #2: the generic authorize() gate backs every subsequent
      // Agent media operation (/tracks, /renegotiate, /tracks/close,
      // /datachannels/*), not just the initial agent-room-media discovery
      // call — so a previously-authorized Agent that already knows its own
      // sessionId and a Human's sessionId/trackName cannot keep creating
      // subscriptions via cached identifiers after Stop/reassignment. Human
      // authorization is completely unaffected.
      if (participant.kind === "agent") {
        // #83 fail-closed direction matrix: every agent media request must
        // carry an explicit narrow purpose; meeting-notes unlocks ONLY
        // remote Human-audio subscribe, voice-reply ONLY local single
        // audio publish; agent-transport covers transport plumbing only;
        // video always denied. Humans are unaffected. dataChannelSessionId
        // is session CORRELATION (validated separately below), never a
        // remote-subscribe direction — the real close/establish calls carry
        // it and must pass under agent-transport's narrow semantics.
        const decision = resolveAgentPurposePermission({
          purpose: request.purpose,
          wantsLocalPublish: (request.localTrackCount ?? 0) > 0,
          wantsRemoteSubscribe:
            (request.remoteTrackCount ?? 0) > 0 ||
            Boolean(request.trackSessionId),
          involvesVideo: false,
        })
        if (!decision.ok) {
          const failure = decision as { ok: false; error: string }
          return this.json({ error: failure.error }, 403)
        }
        if (
          request.wantsVoicePublish === true &&
          !isAgentAuthorizedForVoice(room.agentVoice, participant.id)
        )
          return this.json({ error: "voice_reply_not_authorized" }, 403)
        if (
          request.purpose === "meeting-notes" &&
          !isAgentAuthorizedForMedia(room.meetingNotes, participant.id)
        )
          return this.json({ error: "meeting_notes_not_authorized" }, 403)
        if (
          request.purpose === "voice-reply" &&
          !isAgentAuthorizedForVoice(room.agentVoice, participant.id)
        )
          return this.json({ error: "voice_reply_not_authorized" }, 403)
        // #83 review: the shared transport/bootstrap purpose is authorized
        // by EITHER independent grant — never by an Agent token alone. A
        // room where neither grant names this agent has no media business
        // left on its session at all.
        if (
          request.purpose === "agent-transport" &&
          !isAgentAuthorizedForSharedMedia(
            room.meetingNotes,
            room.agentVoice,
            participant.id
          )
        )
          return this.json({ error: "agent_media_not_authorized" }, 403)
        if (
          participant.media?.agentPublishedMid &&
          (request.localTrackCount ?? 0) > 0
        )
          return this.json({ error: "agent_publish_capacity_exceeded" }, 503)
      }
      // Preflight capacity check *before* the Worker ever
      // calls Cloudflare's tracks/new for any new Agent media track —
      // catching an already-backpressured room here means it never creates
      // yet another upstream subscription only to have agent-track-
      // subscribed reject it afterward (which would just grow the very
      // backlog that caused the rejection). This is in addition to, not a
      // replacement for, that post-upstream check: a grant can still be
      // revoked or reassigned in the window between this call and
      // tracks/new actually completing (the TOCTOU race — finding #2/
      // Blocker 2), which only the post-upstream registration can catch.
      if (participant.kind === "agent") {
        const remoteTrackCount = request.remoteTrackCount ?? 0
        const localTrackCount = request.localTrackCount ?? 0
        if (remoteTrackCount > 0) {
          const activeMids = participant.media?.agentSubscribedMids?.length ?? 0
          if (activeMids + remoteTrackCount > MAX_AGENT_SUBSCRIBED_MIDS)
            return this.json({ error: "agent_media_capacity_exceeded" }, 503)
        }
        const newTrackCount = remoteTrackCount + localTrackCount
        if (newTrackCount > 0) {
          const sessionId =
            participant.media?.sessionId ?? request.sessionId ?? ""
          if (
            !pendingCleanupHasCapacity(
              room.pendingMediaCleanup,
              sessionId,
              newTrackCount
            )
          )
            return this.json({ error: "agent_media_cleanup_backlog" }, 503)
        }
      }
      if (request.trackSessionId && request.trackName) {
        // #83 review: an Agent's exact-track reauthorization must resolve to
        // a HUMAN AUDIO track in room state — never Human video, never
        // another Agent's published voice track — regardless of what
        // identifiers it knows. Humans keep the plain existence check (they
        // legitimately subscribe to screen-share video).
        const trackAllowed =
          participant.kind === "agent"
            ? isHumanAudioTrackTarget(
                room.participants,
                request.trackSessionId,
                request.trackName
              )
            : Object.values(room.participants).some(
                (candidate) =>
                  candidate.media?.sessionId === request.trackSessionId &&
                  candidate.media.tracks.some(
                    (track) => track.trackName === request.trackName
                  )
              )
        if (!trackAllowed) return this.json({ error: "track_not_found" }, 404)
      }
      if (request.dataChannelSessionId) {
        const sessionExists = Object.values(room.participants).some(
          (candidate) =>
            candidate.media?.sessionId === request.dataChannelSessionId &&
            candidate.connected
        )
        if (!sessionExists)
          return this.json({ error: "datachannel_session_not_found" }, 404)
      }
      // kind lets the Worker enforce protocol-level invariants (e.g. an
      // agent's media session must stay subscribe-only) before forwarding
      // a request upstream to Cloudflare Realtime — see /api/sfu/tracks.
      return this.json({ ok: true, kind: participant.kind })
    }

    if (request.action === "reconnect") {
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant || !participant.media)
        return this.json({ error: "unauthorized" }, 401)
      participant.media = {
        ...participant.media,
        sessionId: request.newSessionId,
        fileChannelReady: false,
        tracks: [],
      }
      participant.connected = false
      participant.connectionNonce = undefined
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      return this.json({ ok: true, expiresAt: room.expiresAt })
    }

    const participant = this.findParticipant(
      room,
      request.participantId,
      request.token
    )
    if (!participant) return this.json({ error: "unauthorized" }, 401)

    if (request.action === "publish") {
      // Defense in depth: /api/sfu/tracks already rejects an agent's
      // "local" track before it ever reaches Cloudflare Realtime, so this
      // should be unreachable for an agent in practice — but the room
      // model itself must not accept an agent publication either. Phase-0
      // agent media capability is subscribe-only, full stop.
      if (participant.kind === "agent")
        return this.json({ error: "agent_publish_not_allowed" }, 403)
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      participant.media.tracks = [
        ...participant.media.tracks.filter(
          (track) => track.trackName !== request.track.trackName
        ),
        request.track,
      ]
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.broadcast({
        type: "trackPublished",
        participant: {
          id: participant.id,
          name: participant.name,
          kind: participant.kind,
          sessionId: participant.media.sessionId,
          track: request.track,
        },
      })
      return this.json({ ok: true })
    }

    if (request.action === "agent-track-published") {
      // TOCTOU re-check with the CURRENT grant + exact authenticated session;
      // caller actively closes what Cloudflare just created when this fails.
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant || participant.kind !== "agent")
        return this.json({ error: "unauthorized" }, 401)
      if (
        !isAgentAuthorizedForVoice(room.agentVoice, participant.id) ||
        typeof request.mid !== "string" ||
        request.mid.length === 0
      )
        return this.json({ error: "voice_reply_not_authorized" }, 403)
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      if (
        participant.media.agentPublishedMid &&
        participant.media.agentPublishedMid !== request.mid
      )
        return this.json({ error: "agent_publish_capacity_exceeded" }, 503)
      // This is the post-upstream half of the local publication admission
      // check. A cleanup backlog may have filled after /tracks authorize but
      // before Cloudflare returned this mid; refuse registration so the
      // Worker closes (or durably hands off) this just-created track rather
      // than creating more unrevocable RTP pressure.
      if (
        !participant.media.agentPublishedMid &&
        !pendingCleanupHasCapacity(
          room.pendingMediaCleanup,
          participant.media.sessionId,
          1
        )
      )
        return this.json({ error: "agent_media_cleanup_backlog" }, 503)
      // A replay for an already-visible publication must not retract its
      // public track merely because the original caller used deferred
      // announcement.
      const alreadyVisible =
        participant.media.tracks.length === 1 &&
        participant.media.tracks[0]!.trackName === request.trackName &&
        participant.media.tracks[0]!.kind === "audio"
      const announce = request.announce !== false || alreadyVisible
      participant.media = {
        ...participant.media,
        agentPublishedMid: request.mid,
        // Runtime-owned publications may defer the public broadcast until the
        // bounded silent priming packet makes Cloudflare report the booking
        // active. The Runtime still holds real speech until the browser sends
        // the explicit agent-voice-ready acknowledgement.
        agentPublishedTrackName: request.trackName,
        agentVoiceReady: false,
        tracks: announce
          ? [{ trackName: request.trackName, kind: "audio" }]
          : [],
      }
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      if (announce)
        await this.broadcast({
          type: "trackPublished",
          participant: {
            id: participant.id,
            name: participant.name,
            kind: participant.kind,
            sessionId: participant.media.sessionId,
            track: { trackName: request.trackName, kind: "audio" },
          },
        })
      return this.json({ ok: true })
    }

    if (request.action === "agent-track-active") {
      // The Worker calls this only after Cloudflare reports this publication
      // as active. It is intentionally idempotent because confirmation may
      // be retried after an inactive result or a transient lookup failure.
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant || participant.kind !== "agent")
        return this.json({ error: "unauthorized" }, 401)
      if (!isAgentAuthorizedForVoice(room.agentVoice, participant.id))
        return this.json({ error: "voice_reply_not_authorized" }, 403)
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      if (
        participant.media.tracks.length === 1 &&
        participant.media.tracks[0]!.trackName === request.trackName &&
        participant.media.tracks[0]!.kind === "audio"
      ) {
        if (participant.media.agentPublishedTrackName === request.trackName) {
          delete participant.media.agentPublishedTrackName
          await this.saveRoom(room)
        }
        return this.json({ ok: true })
      }
      if (
        !participant.media.agentPublishedMid ||
        participant.media.agentPublishedTrackName !== request.trackName
      )
        return this.json({ error: "agent_publication_not_ready" }, 409)
      participant.media = {
        ...participant.media,
        tracks: [{ trackName: request.trackName, kind: "audio" }],
      }
      delete participant.media.agentPublishedTrackName
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.broadcast({
        type: "trackPublished",
        participant: {
          id: participant.id,
          name: participant.name,
          kind: participant.kind,
          sessionId: participant.media.sessionId,
          track: { trackName: request.trackName, kind: "audio" },
        },
      })
      return this.json({ ok: true })
    }

    if (request.action === "agent-track-ready") {
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant || participant.kind !== "agent")
        return this.json({ error: "unauthorized" }, 401)
      if (!isAgentAuthorizedForVoice(room.agentVoice, participant.id))
        return this.json({ error: "voice_reply_not_authorized" }, 403)
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      const currentTrackName =
        participant.media.agentPublishedTrackName ??
        (participant.media.tracks.length === 1 &&
        participant.media.tracks[0]!.kind === "audio"
          ? participant.media.tracks[0]!.trackName
          : undefined)
      const ready =
        participant.media.agentVoiceReady === true &&
        currentTrackName === request.trackName
      return this.json({ ready })
    }

    if (request.action === "unpublish") {
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      participant.media.tracks = participant.media.tracks.filter(
        (track) => track.trackName !== request.trackName
      )
      if (
        participant.kind === "agent" &&
        participant.media.agentPublishedTrackName === request.trackName
      ) {
        delete participant.media.agentPublishedTrackName
        delete participant.media.agentPublishedMid
      }
      await this.saveRoom(room)
      await this.broadcastState(room)
      return this.json({ ok: true })
    }

    const grantTransition = transitionMediaGrantsForParticipantDeparture({
      meetingNotes: room.meetingNotes,
      agentVoice: room.agentVoice,
      participant,
    })
    this.stageMediaGrantRevocations(room, grantTransition.revocations)
    if (participant.kind === "human")
      this.removeRuntimeHostProviderAuthorizationForHuman(room, participant.id)
    delete room.participants[participant.id]
    this.garbageCollectRuntimeHostAuthorization(room)
    room.meetingNotes = grantTransition.meetingNotes
    room.agentVoice = grantTransition.agentVoice
    this.applyEmptyRoomExpiry(room, Date.now())
    await this.saveRoom(room)
    await this.broadcastState(room)
    await this.scheduleNextAlarm(room)
    return this.json({ ok: true })
  }

  // #113 shared request ingestion: Agent→Agent and Human→Agent work
  // requests take the identical validate → registry dedup (BEFORE any
  // append) → append → persist → broadcast → waiter-delivery path. The
  // sender is whichever authenticated participant the caller resolved; the
  // registry records fromParticipantId from that sender so Agent responses
  // correlate back to Human requesters exactly as they do for Agents.
  // #115 shared response ingestion: Agent accepted/declined/completed/failed
  // and Human accepted/declined take the identical warm → validate →
  // precheck-dedup (BEFORE any append/wake) → routing → append → commit →
  // persist → broadcast → waiter-delivery path. Routing always comes from
  // CollabRegistry correlation — the responder never self-reports the
  // destination, so a Human response reaches the original requester exactly
  // as an Agent response does.
  private async ingestCollabResponse(
    room: RoomRecord,
    responder: RoomParticipant,
    input: {
      requestId?: unknown
      kind?: unknown
      summary?: unknown
      // Agent completed/failed results may carry bounded details and
      // references to existing attachments (#109); validateCollabEvent
      // preserves both on the canonical event. The Human WS path never
      // supplies them (v0: accepted/declined only).
      details?: unknown
      attachmentIds?: unknown
    }
  ): Promise<
    | {
        status: "recorded" | "duplicate"
        sequence: number
        event: CollabEvent
      }
    | { status: "rejected"; error: string }
  > {
    this.warmCollabRegistry(room)
    const validated = validateCollabEvent(
      input,
      {
        senderParticipantId: responder.id,
        participants: room.participants,
        attachments: room.attachments,
      },
      { generateRequestId: () => crypto.randomUUID() }
    )
    if (validated.ok === false)
      return { status: "rejected", error: validated.error }
    let event = validated.event
    // Idempotency is decided BEFORE any append/wake: a retried identical
    // decision returns the original sequence without producing a second
    // event or a second addressed Harness turn.
    const precheck = this.collabRegistry.precheckResponse(
      event.requestId,
      event.kind,
      responder.id
    )
    if (precheck.action === "rejected")
      return { status: "rejected", error: precheck.error }
    if (precheck.action === "duplicate")
      return {
        status: "duplicate",
        sequence: precheck.sequence,
        event,
      }
    const routing = this.collabRegistry.routingFor(
      event.requestId,
      responder.id
    )
    if (!routing) return { status: "rejected", error: "unknown_request" }
    event = {
      ...event,
      fromParticipantId: routing.fromParticipantId,
      targetParticipantId: routing.targetParticipantId,
    }
    const roomMessage = this.appendMessage(room, {
      id: crypto.randomUUID(),
      peerId: responder.id,
      name: responder.name,
      kind: responder.kind,
      type: "action",
      actionType: COLLAB_ACTION_TYPE,
      collab: event,
      targets:
        event.targetParticipantId !== responder.id
          ? [event.targetParticipantId]
          : undefined,
      createdAt: Date.now(),
    })
    this.collabRegistry.commitResponse(
      event.requestId,
      event.kind,
      roomMessage.sequence
    )
    await this.saveRoom(room)
    await this.scheduleNextAlarm(room)
    await this.broadcast({ type: "message", message: roomMessage })
    this.resolveAgentWaiters(room)
    return {
      status: "recorded",
      sequence: roomMessage.sequence,
      event,
    }
  }

  private async ingestCollabWorkRequest(
    room: RoomRecord,
    sender: RoomParticipant,
    input: {
      requestId?: unknown
      targetParticipantId?: unknown
      summary?: unknown
      // Agent-originated requests may carry bounded details and references
      // to existing room attachments; validateCollabEvent preserves both on
      // the canonical event. The Human WS path never supplies them.
      details?: unknown
      attachmentIds?: unknown
    }
  ): Promise<
    | {
        status: "recorded" | "duplicate"
        sequence: number
        event: CollabEvent
      }
    | { status: "rejected"; error: string }
  > {
    this.warmCollabRegistry(room)
    const validated = validateCollabEvent(
      { kind: "request", ...input },
      {
        senderParticipantId: sender.id,
        participants: room.participants,
        attachments: room.attachments,
      },
      { generateRequestId: () => crypto.randomUUID() }
    )
    if (validated.ok === false)
      return { status: "rejected", error: validated.error }
    const outcome = this.collabRegistry.recordRequest(
      validated.event,
      room.nextMessageSequence + 1
    )
    // Retried send (same requestId): report the original append instead of
    // creating a second, double-execution-inducing event.
    if (outcome.action === "duplicate")
      return {
        status: "duplicate",
        sequence: outcome.sequence,
        event: validated.event,
      }
    const roomMessage = this.appendMessage(room, {
      id: crypto.randomUUID(),
      peerId: sender.id,
      name: sender.name,
      kind: sender.kind,
      type: "action",
      actionType: COLLAB_ACTION_TYPE,
      collab: validated.event,
      targets:
        validated.event.targetParticipantId !== sender.id
          ? [validated.event.targetParticipantId]
          : undefined,
      createdAt: Date.now(),
    })
    await this.saveRoom(room)
    await this.scheduleNextAlarm(room)
    await this.broadcast({ type: "message", message: roomMessage })
    // Addressed-event semantics unchanged: only the targeted resident
    // Runtime wakes; other Agents see a non-addressed context event.
    this.resolveAgentWaiters(room)
    return {
      status: "recorded",
      sequence: roomMessage.sequence,
      event: validated.event,
    }
  }

  // #117: smallest shared attachment reconstruction — metadata lookup
  // against CURRENT room.attachments (the TOCTOU gate: evicted ids fail
  // closed even if detached chunk keys linger) plus bounded chunk
  // reassembly. Authorization lives at the ingress boundaries (Agent MCP
  // path / Human browser path), never here.
  private async readAttachmentPayload(
    room: RoomRecord,
    attachmentId: string
  ): Promise<
    | { attachment: RoomAttachment; data: string }
    | { error: "attachment_unavailable" }
  > {
    const attachment = room.attachments.find(
      (candidate) => candidate.id === attachmentId
    )
    if (!attachment) return { error: "attachment_unavailable" }
    const chunks: Uint8Array[] = []
    for (let index = 0; index < attachment.chunkCount; index += 1) {
      const chunk = await this.ctx.storage.get<ArrayBuffer>(
        this.attachmentChunkKey(attachment.id, index)
      )
      if (!chunk) return { error: "attachment_unavailable" }
      chunks.push(new Uint8Array(chunk))
    }
    let binary = ""
    for (const chunk of chunks)
      for (const byte of chunk) binary += String.fromCharCode(byte)
    return { attachment, data: btoa(binary) }
  }

  private async handleClientMessage(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    message: ClientMessage
  ): Promise<void> {
    const room = await this.activeRoom()
    if (!room) {
      socket.send(JSON.stringify({ type: "expired" }))
      socket.close(4001, "Room expired")
      return
    }
    const participant = this.findParticipant(
      room,
      attachment.participantId,
      attachment.token
    )
    if (!participant || participant.kind !== "human" || !participant.media) {
      socket.close(4003, "Unauthorized")
      return
    }
    participant.lastSeenAt = Date.now()

    if (message.type === "resync") {
      socket.send(JSON.stringify({ type: "state", state: this.stateFor(room) }))
      return
    }
    if (message.type === "runtime-provider-claim-create") {
      // The raw 256-bit secret is browser-local and copied only through an
      // explicit invite. This authenticated WebSocket receives its derived
      // hash, which is one-time and private in RoomRecord until redemption.
      if (
        typeof message.requestId !== "string" ||
        message.requestId.length === 0 ||
        !isRuntimeProviderClaimHash(message.providerClaimHash)
      ) {
        socket.send(JSON.stringify({ type: "error", error: "invalid_request" }))
        return
      }
      const claim = createRuntimeHostProviderClaim({
        pendingClaims: room.runtimeHostProviderClaims ?? {},
        participants: Object.values(room.participants),
        humanParticipantId: participant.id,
        claimHash: message.providerClaimHash,
        now: Date.now(),
      })
      if (claim.ok === false) {
        socket.send(JSON.stringify({ type: "error", error: claim.error }))
        return
      }
      room.runtimeHostProviderClaims = claim.pendingClaims
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      // This is a private request/response acknowledgement: it deliberately
      // creates no Room message, sequence number, broadcast, or waiter wake.
      socket.send(
        JSON.stringify({
          type: "runtime-provider-claim-created",
          requestId: message.requestId,
          expiresAt: claim.expiresAt,
        })
      )
      return
    }
    if (message.type === "leave") {
      this.clearAgentVoiceReadiness(room)
      this.removeRuntimeHostProviderAuthorizationForHuman(room, participant.id)
      delete room.participants[participant.id]
      this.garbageCollectRuntimeHostAuthorization(room)
      this.applyEmptyRoomExpiry(room, Date.now())
      await this.saveRoom(room)
      await this.broadcastState(room)
      await this.scheduleNextAlarm(room)
      socket.close(1000, "Left room")
      return
    }
    if (message.type === "mute") {
      participant.media.muted = message.muted
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }
    if (message.type === "unpublish") {
      participant.media.tracks = participant.media.tracks.filter(
        (track) => track.trackName !== message.trackName
      )
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }
    if (message.type === "datachannel-ready") {
      participant.media.fileChannelReady = true
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }
    if (message.type === "meeting-notes-start") {
      const transition = transitionMeetingNotesStart({
        meetingNotes: room.meetingNotes,
        participants: room.participants,
        pendingMediaCleanup: room.pendingMediaCleanup,
        agentMediaEnabled: this.env.AGENT_MEDIA_ENABLED === "true",
        agentParticipantId: message.agentParticipantId,
        now: Date.now(),
      })
      if (transition.ok === false) {
        socket.send(JSON.stringify({ type: "error", error: transition.error }))
        return
      }
      // A duplicate/replayed Start for the active note-taker preserves its
      // original grant epoch, so the Runtime keeps its existing bridge.
      if (transition.idempotent) {
        socket.send(
          JSON.stringify({ type: "state", state: this.stateFor(room) })
        )
        return
      }
      room.meetingNotes = transition.meetingNotes
      this.stageMediaGrantRevocations(room, transition.revocations)
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.broadcastState(room)
      await this.attemptCleanupNow(room.pendingMediaCleanup)
      return
    }
    if (message.type === "meeting-notes-stop") {
      const transition = transitionMeetingNotesStop(room.meetingNotes)
      room.meetingNotes = transition.meetingNotes
      this.stageMediaGrantRevocations(room, transition.revocations)
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.broadcastState(room)
      await this.attemptCleanupNow(room.pendingMediaCleanup)
      return
    }
    if (message.type === "agent-voice-ready") {
      if (participant.kind !== "human") {
        socket.send(JSON.stringify({ type: "error", error: "human_only" }))
        return
      }
      const agent = room.participants[message.agentParticipantId]
      if (!agent || agent.kind !== "agent" || !agent.connected) {
        socket.send(
          JSON.stringify({ type: "error", error: "agent_not_in_room" })
        )
        return
      }
      if (!isAgentAuthorizedForVoice(room.agentVoice, agent.id)) {
        socket.send(
          JSON.stringify({ type: "error", error: "voice_reply_not_authorized" })
        )
        return
      }
      const media = agent.media
      const currentTrackName =
        media?.agentPublishedTrackName ??
        (media?.tracks.length === 1 && media.tracks[0]!.kind === "audio"
          ? media.tracks[0]!.trackName
          : undefined)
      if (
        !media ||
        media.sessionId !== message.sessionId ||
        !media.agentPublishedMid ||
        currentTrackName !== message.trackName
      ) {
        socket.send(
          JSON.stringify({
            type: "error",
            error: "agent_publication_not_ready",
          })
        )
        return
      }
      // Idempotent duplicate acknowledgements are harmless. The private
      // readiness bit is tied to the exact current media session/publication
      // above, so an old browser subscription cannot arm a new one.
      if (media.agentVoiceReady !== true) {
        media.agentVoiceReady = true
        agent.lastSeenAt = Date.now()
        await this.saveRoom(room)
      }
      return
    }
    if (message.type === "agent-voice-set") {
      if (participant.kind !== "human") {
        socket.send(JSON.stringify({ type: "error", error: "human_only" }))
        return
      }
      const transition = transitionAgentVoiceSet({
        agentVoice: room.agentVoice,
        participants: room.participants,
        runtimeHosts: room.runtimeHosts,
        pendingMediaCleanup: room.pendingMediaCleanup,
        agentMediaEnabled: this.env.AGENT_MEDIA_ENABLED === "true",
        agentParticipantId: message.agentParticipantId,
        enabled: message.enabled,
        now: Date.now(),
      })
      if (transition.ok === false) {
        socket.send(JSON.stringify({ type: "error", error: transition.error }))
        return
      }
      room.agentVoice = transition.agentVoice
      this.stageMediaGrantRevocations(room, transition.revocations)
      // This is presence/authorization state only: no RoomMessage, sequence
      // increment, or Agent waiter wakeup.
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.broadcastState(room)
      await this.attemptCleanupNow(room.pendingMediaCleanup)
      return
    }

    // #113: Human-originated structured work request. The sender is the
    // authenticated WebSocket attachment — payload never carries identity.
    if (message.type === "collab-request") {
      const reject = (error: string) =>
        socket.send(JSON.stringify({ type: "error", error }))
      if (participant.kind !== "human") {
        reject("collab_sender_not_human")
        return
      }
      const target = room.participants[message.targetParticipantId] ?? null
      if (!target || !target.connected) {
        reject("collab_target_not_in_room")
        return
      }
      if (target.kind !== "agent") {
        reject("collab_target_not_agent")
        return
      }
      const ingest = await this.ingestCollabWorkRequest(room, participant, {
        requestId: message.requestId,
        targetParticipantId: message.targetParticipantId,
        summary: message.summary,
        attachmentIds: message.attachmentIds,
      })
      if (ingest.status === "rejected") {
        reject(ingest.error)
        return
      }
      if (ingest.status === "duplicate") {
        reject("collab_duplicate_request_id")
        return
      }
      // The canonical RoomMessage was already broadcast; the Human UI learns
      // of it through the ordinary message path (no optimistic echo here).
      return
    }

    // #115: Human accepted/declined for an Agent-originated request. The
    // responder is the authenticated Human attachment; routing comes from
    // CollabRegistry correlation. v0 permits ONLY accepted/declined —
    // completed/failed remain Agent-submitted.
    if (message.type === "collab-response") {
      const reject = (error: string) =>
        socket.send(JSON.stringify({ type: "error", error }))
      if (participant.kind !== "human") {
        reject("collab_responder_not_human")
        return
      }
      if (message.decision !== "accepted" && message.decision !== "declined") {
        reject("invalid_collab_kind")
        return
      }
      const ingest = await this.ingestCollabResponse(room, participant, {
        requestId: message.requestId,
        kind: message.decision,
        summary: message.summary,
      })
      if (ingest.status === "rejected") {
        reject(ingest.error)
        return
      }
      // Canonical RoomMessage already broadcast (duplicate retries append
      // nothing and wake nothing); the UI learns state via the ordinary path.
      return
    }

    // #119: Human capability advertisement is presence/discovery state.
    // Fail closed on invalid input (no mutation/persist/broadcast); valid
    // updates replace the entire advertised list atomically and NEVER touch
    // messages, sequence numbers, collab state, or Agent waiters.
    if (message.type === "human-update-capabilities") {
      if (participant.kind !== "human") {
        socket.send(JSON.stringify({ type: "error", error: "human_only" }))
        return
      }
      const validated = validateAdvertisedCapabilities(message.capabilities)
      if (validated.ok === false) {
        socket.send(JSON.stringify({ type: "error", error: validated.error }))
        return
      }
      participant.lastSeenAt = Date.now()
      if (validated.capabilities.length === 0) delete participant.advertised
      else participant.advertised = validated.capabilities
      await this.saveRoom(room)
      // Presence/discovery broadcast only — deliberately no waiter wake.
      await this.broadcastState(room)
      return
    }

    // #121: Human terminal result (completed | failed) for an
    // Agent-originated request this Human previously accepted. Same shared
    // response ingestion as every other lifecycle event: warm → validate →
    // precheck-dedup BEFORE any append/wake → registry routing → ONE
    // canonical message targeted back at the original requester.
    if (message.type === "collab-result") {
      const reject = (error: string) =>
        socket.send(JSON.stringify({ type: "error", error }))
      if (participant.kind !== "human") {
        reject("collab_responder_not_human")
        return
      }
      if (message.status !== "completed" && message.status !== "failed") {
        reject("invalid_collab_kind")
        return
      }
      const summary = message.summary?.trim() ?? ""
      if (!summary) {
        reject("summary_required")
        return
      }
      if (summary.length > MAX_COLLAB_SUMMARY_LENGTH) {
        reject("summary_too_long")
        return
      }
      const ingest = await this.ingestCollabResponse(room, participant, {
        requestId: message.requestId,
        kind: message.status,
        summary,
      })
      if (ingest.status === "rejected") {
        reject(ingest.error)
        return
      }
      // Canonical message already broadcast; duplicates append nothing and
      // wake nothing by construction.
      return
    }

    if (message.type === "chat" && message.text.trim()) {
      const roomMessage = this.appendMessage(room, {
        id: crypto.randomUUID(),
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        type: "text",
        text: message.text.trim().slice(0, 4000),
        ...(() => {
          const targets = normalizeChatTargets(room, message.targets)
          return targets.length ? { targets } : {}
        })(),
        createdAt: Date.now(),
      })
      await this.saveRoom(room)
      await this.broadcast({ type: "message", message: roomMessage })
      this.resolveAgentWaiters(room)
      return
    }

    if (message.type === "action") {
      const roomMessage = this.appendMessage(room, {
        id: crypto.randomUUID(),
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        type: "action",
        actionType: message.actionType,
        actionPayload: message.actionPayload,
        createdAt: Date.now(),
      })
      await this.saveRoom(room)
      await this.broadcast({ type: "message", message: roomMessage })
      this.resolveAgentWaiters(room)
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/attachment")
      return this.handleAttachmentUpload(request)
    if (request.method === "POST" && url.pathname === "/surface")
      return this.handleSurfaceUpload(request)
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (request.method !== "GET")
        return this.json({ error: "method_not_allowed" }, 405)
      const participantId = url.searchParams.get("participantId")
      const token = url.searchParams.get("token")
      if (!participantId || !token)
        return this.json({ error: "unauthorized" }, 401)
      const room = await this.activeRoom()
      const participant =
        room && this.findParticipant(room, participantId, token)
      if (
        !room ||
        !participant ||
        participant.kind !== "human" ||
        !participant.media
      )
        return this.json({ error: "unauthorized" }, 401)

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
      const connectionNonce = crypto.randomUUID()
      participant.connected = true
      participant.connectionNonce = connectionNonce
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({ participantId, token, connectionNonce })
      server.send(JSON.stringify({ type: "state", state: this.stateFor(room) }))
      await this.broadcastState(room, server)
      return new Response(null, { status: 101, webSocket: client })
    }

    if (request.method !== "POST" || url.pathname !== "/control") {
      return this.json({ error: "not_found" }, 404)
    }
    try {
      return await this.handleControl((await request.json()) as ControlRequest)
    } catch {
      return this.json({ error: "invalid_request" }, 400)
    }
  }

  private isAgentAttachmentMimeType(
    value: string
  ): value is AgentAttachmentMimeType {
    return (
      value === "image/jpeg" ||
      value === "image/png" ||
      value === "image/webp" ||
      value === "text/plain" ||
      value === "text/markdown" ||
      value === "text/csv" ||
      value === "application/json" ||
      value === "text/yaml"
    )
  }

  // #111 Observable Agent Workspace publish. Order matters: policy first
  // (no storage touched on rejection), then new chunks, THEN the atomic
  // metadata swap + broadcast, and only afterward best-effort old-chunk
  // deletion — a failure at any point leaves the previous snapshot intact.
  // Deliberately does NOT touch messages, sequence numbers, agent waiters,
  // or attachments: a surface update is observation metadata, never a chat
  // event or Harness wake.
  private async handleSurfaceUpload(request: Request): Promise<Response> {
    const room = await this.activeRoom()
    if (!room) return this.json({ error: "room_expired" }, 410)
    const participantId = request.headers.get("X-Room-Participant-Id") ?? ""
    const token = request.headers.get("X-Room-Participant-Token") ?? ""
    const mimeType = (request.headers.get("X-Surface-MimeType") ?? "")
      .split(";", 1)[0]
      .toLowerCase()
    const participant = this.findParticipant(room, participantId, token)
    if (!participant) return this.json({ error: "unauthorized" }, 401)
    if (participant.kind !== "agent")
      return this.json({ error: "surface_agent_only" }, 403)
    const declaredSize = Number(request.headers.get("Content-Length") ?? "0")
    const bytes = new Uint8Array(await request.arrayBuffer())
    const otherActiveSurfaces = Object.values(room.participants).filter(
      (candidate) =>
        candidate.kind === "agent" &&
        candidate.id !== participantId &&
        Boolean(candidate.surface)
    ).length
    const policy = evaluateSurfacePublish({
      mimeType,
      declaredSize,
      byteLength: bytes.byteLength,
      otherActiveSurfaces,
      publisherHasSurface: Boolean(participant.surface),
      publisherLastUpdatedAt: participant.surface?.updatedAt,
      now: Date.now(),
    })
    if (policy.ok === false)
      return this.json(
        { error: policy.error },
        policy.error === "surface_rate_limited"
          ? 429
          : policy.error === "surface_capacity_exceeded"
          ? 503
          : 400
      )
    const snapshotId = crypto.randomUUID()
    try {
      for (let index = 0; index < policy.chunkCount; index += 1) {
        const start = index * SURFACE_CHUNK_SIZE
        await this.ctx.storage.put(
          surfaceChunkKey(participantId, snapshotId, index),
          bytes.slice(start, start + SURFACE_CHUNK_SIZE)
        )
      }
    } catch {
      // Roll back partial NEW chunks; previous surface untouched.
      const partialKeys: string[] = []
      for (let index = 0; index < policy.chunkCount; index += 1)
        partialKeys.push(surfaceChunkKey(participantId, snapshotId, index))
      await this.ctx.storage.delete(partialKeys)
      return this.json({ error: "surface_unavailable" }, 503)
    }
    const previous = participant.surface
    const updated = {
      kind: "workspace-snapshot" as const,
      snapshotId,
      mimeType: mimeType as RoomSurfaceV1["mimeType"],
      size: bytes.byteLength,
      updatedAt: Date.now(),
    }
    // Post-commit replacement (#111 review): persist + broadcast first, then
    // best-effort old-chunk deletion via the injectable seam — a failure
    // deleting A can never fail a publish whose B is already committed.
    const surface = await swapSurfaceAfterPersist({
      participant,
      previous,
      updated,
      persistAndBroadcast: async () => {
        await this.saveRoom(room)
        await this.broadcastState(room)
      },
      deleteOldChunks: previous
        ? () => this.deleteSurfaceChunks(participantId, previous)
        : async () => {},
    })
    return this.json({ surface, expiresAt: room.expiresAt })
  }

  private async handleAttachmentUpload(request: Request): Promise<Response> {
    const room = await this.activeRoom()
    if (!room) return this.json({ error: "room_expired" }, 410)
    const participantId = request.headers.get("X-Room-Participant-Id") ?? ""
    const token = request.headers.get("X-Room-Participant-Token") ?? ""
    const participant = this.findParticipant(room, participantId, token)
    if (!participant) return this.json({ error: "unauthorized" }, 401)
    // #106: agents as well as humans may contribute to the room's bounded
    // ephemeral attachment set — a collaborating agent's screenshot/log/JSON
    // artifact rides the exact same store, limits, and eviction rules as
    // human uploads (no new persistence is introduced).
    const mimeType = (request.headers.get("Content-Type") ?? "")
      .split(";", 1)[0]
      .toLowerCase()
    if (!this.isAgentAttachmentMimeType(mimeType))
      return this.json({ error: "unsupported_attachment_type" }, 415)
    const declaredSize = Number(request.headers.get("Content-Length") ?? "0")
    if (declaredSize > MAX_AGENT_ATTACHMENT_BYTES)
      return this.json({ error: "attachment_too_large" }, 413)
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_AGENT_ATTACHMENT_BYTES ||
      (declaredSize > 0 && declaredSize !== bytes.byteLength)
    )
      return this.json({ error: "invalid_attachment" }, 400)

    let fileName = request.headers.get("X-File-Name") ?? "image"
    try {
      fileName = decodeURIComponent(fileName)
    } catch {
      fileName = "image"
    }
    fileName = fileName.trim().slice(0, 256) || "image"
    const id = crypto.randomUUID()
    const chunkCount = Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_SIZE)
    const attachment: RoomAttachment = {
      id,
      senderId: participant.id,
      senderName: participant.name,
      mimeType: mimeType as AgentAttachmentMimeType,
      fileName,
      size: bytes.byteLength,
      chunkCount,
      createdAt: Date.now(),
      sequence: room.nextMessageSequence + 1,
    }
    try {
      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * ATTACHMENT_CHUNK_SIZE
        await this.ctx.storage.put(
          this.attachmentChunkKey(id, index),
          bytes.slice(start, start + ATTACHMENT_CHUNK_SIZE)
        )
      }
      room.nextMessageSequence = attachment.sequence
      room.attachments = [...room.attachments, attachment]
      const evicted = room.attachments.splice(
        0,
        Math.max(0, room.attachments.length - MAX_AGENT_ATTACHMENTS)
      )
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      for (const oldAttachment of evicted)
        await this.deleteAttachmentChunks(oldAttachment)
      await this.scheduleNextAlarm(room)
      this.resolveAgentWaiters(room)
      return this.json({ attachment: { ...attachment } })
    } catch {
      await this.deleteAttachmentChunks(attachment)
      return this.json({ error: "attachment_unavailable" }, 503)
    }
  }

  async webSocketMessage(
    socket: WebSocket,
    raw: string | ArrayBuffer
  ): Promise<void> {
    if (typeof raw !== "string") return
    const attachment =
      socket.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) return socket.close(4003, "Missing connection state")
    try {
      await this.handleClientMessage(
        socket,
        attachment,
        JSON.parse(raw) as ClientMessage
      )
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "invalid_message" }))
    }
  }

  async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const attachment =
      socket.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) return
    const room = await this.activeRoom()
    if (!room) return
    const participant = room.participants[attachment.participantId]
    if (
      !participant ||
      participant.connectionNonce !== attachment.connectionNonce
    )
      return
    participant.connected = false
    participant.lastSeenAt = Date.now()
    participant.connectionNonce = undefined
    this.clearAgentVoiceReadiness(room)
    await this.saveRoom(room)
    await this.scheduleNextAlarm(room)
    await this.broadcastState(room)
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket, 1011, "WebSocket error", false)
  }

  async alarm(): Promise<void> {
    const room = await this.loadRoom()
    if (!room) return
    const now = Date.now()
    if (now >= room.expiresAt) {
      await this.expireRoom(room)
      return
    }
    let changed = false
    const expiredSurfaces: Array<{
      participantId: string
      surface: RoomSurfaceV1
    }> = []
    for (const [id, participant] of Object.entries(room.participants)) {
      const expiredHuman =
        participant.kind === "human" &&
        !participant.connected &&
        participant.lastSeenAt + RECONNECT_GRACE_MS <= now
      const expiredAgent =
        participant.kind === "agent" &&
        participant.lastSeenAt + AGENT_LEASE_MS <= now
      if (expiredHuman || expiredAgent) {
        // Synchronous staging only here — no Cloudflare fetch is attempted
        // until after this whole sweep is persisted below (round 4).
        const grantTransition = transitionMediaGrantsForParticipantDeparture({
          meetingNotes: room.meetingNotes,
          agentVoice: room.agentVoice,
          participant,
        })
        this.stageMediaGrantRevocations(room, grantTransition.revocations)
        // #111: lease-expired agents lose their surface with them; chunk
        // deletion happens after the sweep is persisted (below).
        if (participant.surface)
          expiredSurfaces.push({
            participantId: id,
            surface: participant.surface,
          })
        if (expiredHuman)
          this.removeRuntimeHostProviderAuthorizationForHuman(room, id)
        delete room.participants[id]
        this.garbageCollectRuntimeHostAuthorization(room)
        room.meetingNotes = grantTransition.meetingNotes
        room.agentVoice = grantTransition.agentVoice
        changed = true
        const waiter = this.agentWaiters.get(id)
        if (waiter) {
          this.finishWaiter(
            waiter,
            this.json({
              events: [],
              cursor: room.nextMessageSequence,
              expiresAt: room.expiresAt,
              left: true,
            })
          )
        } else {
          this.agentWaiters.delete(id)
        }
      }
    }
    if (changed) {
      this.applyEmptyRoomExpiry(room, now)
      await this.saveRoom(room)
      await this.broadcastState(room)
    }
    // #111: chunk deletion after persistence — no surface outlives its
    // lease-expired owner. Best-effort: the sweep must continue to
    // scheduleNextAlarm regardless of individual deletion failures.
    for (const { participantId, surface } of expiredSurfaces)
      await deleteSurfaceChunksBestEffort(() =>
        this.deleteSurfaceChunks(participantId, surface)
      )
    await this.scheduleNextAlarm(room)
    // External I/O last, after every storage-only mutation above is
    // already durable (round 4): attemptCleanupNow takes a read-only
    // snapshot and does its own fresh reload + narrow merge afterward — it
    // never reuses this `room` reference for its own save.
    await this.attemptCleanupNow(room.pendingMediaCleanup)
  }
}
